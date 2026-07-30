/**
 * Prebuilt content — the mask's own factory images and animations.
 *
 * Two things make this harder than a list of buttons. The mask has no way to report what index 7
 * looks like, or even how many indices exist, so a tile can only ever show a number; and it has no
 * way to report what is currently showing, so "selected" here means "the last thing WE sent", which
 * is the honest claim. The fix for the first is human: tap ✎ and name them once, and the names live
 * in localStorage from then on.
 *
 * No motion or speed controls here on purpose — MODE and SPEED drive the scrolling text band, not
 * built-in content, so they live in the text panel where they actually do something.
 */
import { html, useState } from 'preact';
import { mask } from '../mask.js';
import { command } from '../mask-protocol.js';
import { Card, Chips, Btn } from '../ui-kit.js';
import { labels, useStore } from '../store.js';

const COUNT = 20;

const KINDS = [
  { value: 'IMAG', label: 'Images', send: (i) => command.image(i) },
  { value: 'ANIM', label: 'Animations', send: (i) => command.animation(i) },
];

export function PrebuiltPanel() {
  const [kind, setKind] = useState('IMAG');
  const [active, setActive] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [names, setNames] = useStore(labels);

  const send = KINDS.find((k) => k.value === kind).send;

  const rename = (index) => {
    const key = `${kind}:${index}`;
    const next = prompt(`Name for ${kind} ${index}`, names[key] ?? '');
    if (next === null) return;
    setNames({ ...names, [key]: next.trim() });
  };

  const pick = async (index) => {
    if (renaming) return rename(index);
    setActive(index);
    await mask.sendCommand(send(index), `${kind} ${index}`);
  };

  return html`
    <${Card}
      title="Prebuilt"
      hint="The mask's own images and animations. It can't tell us what they look like — name them once and they stick."
      actions=${html`
        <button class=${`ghost ${renaming ? 'on' : ''}`} onClick=${() => setRenaming(!renaming)}>
          ${renaming ? 'Done' : '✎ Name'}
        </button>
      `}
    >
      <${Chips} options=${KINDS} value=${kind}
        onPick=${(v) => { setKind(v); setActive(null); }} />

      <div class=${`tiles ${renaming ? 'renaming' : ''}`}>
        ${Array.from({ length: COUNT }, (_, i) => {
          const name = names[`${kind}:${i}`];
          return html`
            <button
              key=${i}
              class=${`tile ${active === i ? 'on' : ''}`}
              onClick=${() => pick(i)}
              title=${name || `${kind} ${i}`}
            >
              <span class="tile-index">${i}</span>
              <span class="tile-name">${name || (renaming ? 'name it…' : '')}</span>
            </button>
          `;
        })}
      </div>

      <div class="cta">
        <${Btn} onClick=${() => mask.sendCommand(command.foregroundColor(255, 255, 255, 0), 'FC release')}>
          Restore original colours
        <//>
      </div>
      <p class="hint">
        A colour override outlives the content that set it, so built-in images can come out one flat
        colour. That button hands colour back to the image.
      </p>
    <//>
  `;
}
