// In-game chat for multiplayer: a message list on the left of the screen
// (lines fade after a while unless the chat is open) and a text box opened
// with Enter or T (or the chat button on touch screens).
const SHOW_FOR = 12000; // ms a line stays up while the chat is closed
const KEEP = 40; // lines kept

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Chat {
  /** @param {{ onSend(text: string): void, onOpenChange?(open: boolean): void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.root = el('div');
    this.root.id = 'chat';
    this.log = el('div', 'log');
    this.form = el('form', 'entry');
    this.input = el('input');
    Object.assign(this.input, { type: 'text', maxLength: 200, placeholder: 'Say something… (Enter to send, Esc to cancel)', autocomplete: 'off', spellcheck: false });
    this.form.append(this.input);
    this.root.append(this.log, this.form);
    document.body.append(this.root);
    this.open = false;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      this.input.value = '';
      if (text) this.opts.onSend(text);
      this.close();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.input.value = '';
        this.close();
      }
      e.stopPropagation(); // typing never flies the aeroplane
    });
    this.input.addEventListener('blur', () => this.close());
  }

  /**
   * Add a line.
   * @param {string} name   who said it ('' for a notice)
   * @param {string} text
   * @param {boolean} own   said by this player
   */
  add(name, text, own = false) {
    const line = el('div', own ? 'line own' : name ? 'line' : 'line note');
    if (name) line.append(el('b', '', `${name}: `));
    line.append(document.createTextNode(text)); // text only: never HTML
    this.log.append(line);
    while (this.log.children.length > KEEP) this.log.firstChild.remove();
    setTimeout(() => line.classList.add('old'), SHOW_FOR);
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.classList.add('open');
    this.input.focus();
    this.opts.onOpenChange?.(true);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('open');
    this.input.blur();
    this.opts.onOpenChange?.(false);
  }

  clear() {
    this.log.replaceChildren();
  }
}
