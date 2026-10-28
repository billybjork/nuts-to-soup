// Validate at the extension boundary, before any state mutation or page command.
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const alias = (value) => text(value) && /^[a-zA-Z0-9_-]+$/.test(value);
const time = (value) => Number.isFinite(value) && value >= 0;
const aliases = (value) => Array.isArray(value) && value.length <= 10000 && value.every(alias);
const content = new Set(['nowPlaying', 'progress', 'ended', 'scraped', 'isSyncTab', 'refreshStream']);

export function validateMessage(m, sender) {
  if (!m || typeof m !== 'object') throw new Error('Invalid message');
  if (content.has(m.type)) {
    if (
      !Number.isInteger(sender.tab?.id) ||
      sender.frameId !== 0 ||
      !sender.url?.startsWith('https://www.nts.live/')
    ) {
      throw new Error('This message requires an NTS page');
    }
  } else if (sender.tab && !sender.url?.startsWith('chrome-extension://')) {
    throw new Error('This command requires the extension panel');
  }
  let valid = true;
  switch (m.type) {
    case 'play':
    case 'top':
      valid = alias(m.alias);
      break;
    case 'jump':
      valid = alias(m.alias) && time(m.offset) && text(m.path);
      break;
    case 'toggle':
      valid = typeof m.play === 'boolean';
      break;
    case 'settings':
      valid = typeof m.settings?.autoAdvance === 'boolean' && Object.keys(m.settings).length === 1;
      break;
    case 'remove':
      valid = aliases(m.aliases);
      break;
    case 'reorder':
      valid =
        aliases(m.aliases) &&
        new Set(m.aliases).size === m.aliases.length &&
        Number.isInteger(m.moved) &&
        m.moved >= 0 &&
        m.moved < m.aliases.length &&
        Number.isInteger(m.from) &&
        m.from >= 0 &&
        m.from < m.aliases.length;
      break;
    case 'add':
      valid = Array.isArray(m.urls) && m.urls.length <= 100 && m.urls.every(text);
      break;
    case 'nowPlaying':
      valid =
        alias(m.alias) &&
        text(m.playbackId) &&
        text(m.path) &&
        time(m.startedAt) &&
        time(m.pos) &&
        time(m.dur);
      break;
    case 'progress':
      valid =
        alias(m.alias) && text(m.playbackId) && time(m.pos) && time(m.dur) && typeof m.playing === 'boolean';
      break;
    case 'ended':
      valid = alias(m.alias) && text(m.playbackId);
      break;
    case 'refreshStream':
      valid = Number.isInteger(m.index) && m.index >= 0;
      break;
    case 'scraped':
      valid =
        m.kind === 'signedOut' ||
        (['shows', 'saved', 'history'].includes(m.kind) &&
          typeof m.complete === 'boolean' &&
          Array.isArray(m.items) &&
          m.items.length <= 10000 &&
          m.items.every((item) =>
            m.kind === 'shows' ? alias(item?.alias) && text(item?.name) : text(item),
          ));
      break;
  }
  if (!valid) throw new Error(`Invalid ${m.type} message`);
}
