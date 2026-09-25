/** Mirrors caption state into the small native window, without a second TTL. */
export class BubbleSurface {
  constructor(element, layout) {
    this.element = element;
    this.layout = layout;
    this.revision = -1;
    this.layoutRevision = -1;
    this.request = 0;
    this.closed = false;
    element.style.display = 'none';
    element.dataset.state = 'hidden';
  }

  async update(state) {
    if (
      this.closed ||
      !state ||
      state.revision < this.revision ||
      (state.revision === this.revision && state.layoutRevision < this.layoutRevision)
    )
      return;
    this.revision = state.revision;
    this.layoutRevision = state.layoutRevision;
    const request = ++this.request;
    const element = this.element;
    if (state.state === 'hidden') {
      element.dataset.state = 'hidden';
      element.style.display = 'none';
      element.textContent = '';
      return;
    }
    if (state.state === 'hiding') {
      if (element.dataset.state !== 'hidden') element.dataset.state = 'hiding';
      return;
    }
    const entering = element.dataset.state === 'hidden' || element.dataset.state === 'entering';
    element.textContent = state.text;
    element.style.maxWidth = `${Math.max(1, Math.min(300, state.maxWidth))}px`;
    element.style.maxHeight = `${Math.max(1, state.maxHeight)}px`;
    element.style.display = 'block';
    if (entering) element.dataset.state = 'entering';
    // offset sizes exclude the transient transform and include the border.
    await this.layout({
      revision: state.revision,
      layoutRevision: state.layoutRevision,
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
    if (this.closed || request !== this.request) return;
    if (entering) void element.offsetHeight;
    element.dataset.state = 'visible';
  }

  dispose() {
    this.closed = true;
    this.request++;
    this.element.style.display = 'none';
    this.element.textContent = '';
  }
}
