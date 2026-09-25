// Keep native controls, text selections and scrolling alive during status updates.
// HTML comes only from our escaped component templates, never directly from AI.
const rendered = new WeakMap();

export function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function key(node) {
  if (node.nodeType !== 1) return '';
  if (node.id) return `id:${node.id}`;
  if (node.hasAttribute('name'))
    return `field:${node.getAttribute('name')}:${node.getAttribute('type') || ''}:${node.type === 'radio' ? node.value : ''}`;
  if (node.localName === 'option') return `option:${node.value}`;
  if (node.hasAttribute('data-do'))
    return `action:${node.dataset.do}:${node.dataset.id || node.dataset.kind || ''}`;
  return '';
}

function compatible(a, b) {
  return (
    a.nodeType === b.nodeType &&
    a.nodeName === b.nodeName &&
    a.namespaceURI === b.namespaceURI &&
    key(a) === key(b)
  );
}

function patchNode(current, next, preserveFields, syncFields) {
  // isEqualNode does not compare live input values or checked properties.
  // An explicit draft reset must visit fields even when their markup is equal.
  if (!syncFields && current.isEqualNode(next)) return;
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName);
  const preserve =
    preserveFields &&
    field &&
    (current.hasAttribute('data-dirty') || current.getRootNode().activeElement === current);
  const value = preserve ? current.value : next.value;
  const checked = preserve ? current.checked : next.checked;
  for (const attribute of [...current.attributes]) {
    if (
      attribute.name === 'data-dirty' ||
      (current.tagName === 'DETAILS' && attribute.name === 'open')
    )
      continue;
    if (preserve && ['value', 'checked'].includes(attribute.name)) continue;
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (preserve && ['value', 'checked'].includes(attribute.name)) continue;
    if (current.getAttribute(attribute.name) !== attribute.value)
      current.setAttribute(attribute.name, attribute.value);
  }
  // A textarea's children are its default value, not the current editing buffer.
  if (!(preserve && current.tagName === 'TEXTAREA'))
    patchChildren(current, next, preserveFields, syncFields);
  if (field) {
    if (current.value !== value) current.value = value;
    if (current.tagName === 'INPUT' && current.checked !== checked) current.checked = checked;
  }
}

function patchChildren(parent, next, preserveFields, syncFields) {
  let current = parent.firstChild;
  const children = [...next.childNodes];
  for (const [index, desired] of children.entries()) {
    if (!current || !compatible(current, desired)) {
      let match = current?.nextSibling;
      while (match && !compatible(match, desired)) match = match.nextSibling;
      if (match) {
        // Remove an obsolete banner before a form without detaching that form:
        // even moving the same node would close its native select popup.
        while (
          current !== match &&
          !children.slice(index + 1).some((node) => compatible(current, node))
        ) {
          const following = current.nextSibling;
          current.remove();
          current = following;
        }
        if (current !== match) parent.insertBefore(match, current);
      } else {
        parent.insertBefore(desired.cloneNode(true), current);
        continue;
      }
      current = match;
    }
    const following = current.nextSibling;
    patchNode(current, desired, preserveFields, syncFields);
    current = following;
  }
  while (current) {
    const following = current.nextSibling;
    current.remove();
    current = following;
  }
}

export function patchHTML(element, html, { reset = false, syncFields = false } = {}) {
  if (!reset && !syncFields && rendered.get(element) === html) return;
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = html;
  if (reset) element.replaceChildren(template.content);
  else patchChildren(element, template.content, true, syncFields);
  rendered.set(element, html);
}
