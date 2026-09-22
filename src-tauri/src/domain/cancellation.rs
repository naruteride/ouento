use std::future::Future;
use tokio::sync::watch;

/// A new generation invalidates every future and renderer response from the old one.
pub struct Cancellation {
    sender: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct RequestToken {
    generation: u64,
    receiver: watch::Receiver<u64>,
}

impl Default for Cancellation {
    fn default() -> Self {
        let (sender, _) = watch::channel(0);
        Self { sender }
    }
}
impl Cancellation {
    pub fn begin(&self) -> RequestToken {
        let mut generation = 0;
        self.sender.send_modify(|g| {
            *g = g.wrapping_add(1);
            generation = *g;
        });
        RequestToken {
            generation,
            receiver: self.sender.subscribe(),
        }
    }
    pub fn cancel(&self) {
        self.sender.send_modify(|g| *g = g.wrapping_add(1));
    }
    pub fn cancel_if_current(&self, id: &str) -> bool {
        let Ok(expected) = id.parse::<u64>() else {
            return false;
        };
        self.sender.send_if_modified(|generation| {
            if *generation != expected {
                return false;
            }
            *generation = generation.wrapping_add(1);
            true
        })
    }
    pub fn begin_if_current(&self, expected: u64) -> Result<RequestToken, String> {
        let mut generation = expected;
        let advanced = self.sender.send_if_modified(|g| {
            if *g != expected {
                return false;
            }
            *g = g.wrapping_add(1);
            generation = *g;
            true
        });
        if !advanced {
            return Err("새 대화가 시작되어 이전 반응을 취소했습니다.".into());
        }
        let token = RequestToken {
            generation,
            receiver: self.sender.subscribe(),
        };
        token.check()?;
        Ok(token)
    }
    pub fn generation(&self) -> u64 {
        *self.sender.borrow()
    }
    pub fn current(&self, id: &str) -> Result<RequestToken, String> {
        let generation: u64 = id.parse().map_err(|_| "발화 ID가 올바르지 않습니다.")?;
        let token = RequestToken {
            generation,
            receiver: self.sender.subscribe(),
        };
        token.check()?;
        Ok(token)
    }
}
impl RequestToken {
    pub fn id(&self) -> String {
        self.generation.to_string()
    }
    pub fn check(&self) -> Result<(), String> {
        if *self.receiver.borrow() == self.generation {
            Ok(())
        } else {
            Err("취소된 요청입니다.".into())
        }
    }
    async fn cancelled(&mut self) {
        loop {
            if *self.receiver.borrow_and_update() != self.generation {
                return;
            }
            if self.receiver.changed().await.is_err() {
                return;
            }
        }
    }
    pub async fn run<T>(
        &self,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.check()?;
        let mut token = self.clone();
        let output = tokio::select! {
            biased;
            _ = token.cancelled() => Err("취소된 요청입니다.".into()),
            result = future => result,
        }?;
        self.check()?;
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_responses_are_invalid_after_cancel_or_new_request() {
        let c = Cancellation::default();
        let first = c.begin();
        let second = c.begin();
        assert!(first.check().is_err());
        assert!(second.check().is_ok());
        c.cancel();
        assert!(second.check().is_err());
        assert!(c.current(&second.id()).is_err());
    }
    #[test]
    fn observation_cannot_replace_a_newer_user_turn() {
        let c = Cancellation::default();
        let observed_generation = c.generation();
        let direct = c.begin();
        assert!(c.begin_if_current(observed_generation).is_err());
        assert!(direct.check().is_ok());
        let response = c.begin_if_current(c.generation()).unwrap();
        assert!(response.check().is_ok());
        assert!(direct.check().is_err());
    }
    #[test]
    fn late_request_specific_cancellation_cannot_advance_a_new_generation() {
        let cancellation = Cancellation::default();
        let old = cancellation.begin();
        let current = cancellation.begin();
        assert!(!cancellation.cancel_if_current(&old.id()));
        assert!(current.check().is_ok());
        assert!(cancellation.cancel_if_current(&current.id()));
        assert!(current.check().is_err());
    }
    #[tokio::test]
    async fn cancellation_drops_network_future() {
        let c = Cancellation::default();
        let token = c.begin();
        let request = token.run(std::future::pending::<Result<(), String>>());
        let cancel = async {
            tokio::task::yield_now().await;
            c.cancel();
        };
        let (result, _) = tokio::join!(request, cancel);
        assert_eq!(result.unwrap_err(), "취소된 요청입니다.");
    }
}
