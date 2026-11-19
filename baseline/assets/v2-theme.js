/* Platform appearance bridge. Business messages retain their original protocol. */
(() => {
  const tokens = new Set(['background','foreground','card','card-foreground','popover','popover-foreground','primary','primary-foreground','secondary','secondary-foreground','muted','muted-foreground','accent','accent-foreground','border','input','ring','radius']);
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'bg-v2-theme') return;
    document.documentElement.classList.toggle('dark', event.data.dark === true);
    for (const [key, value] of Object.entries(event.data.tokens || {})) {
      if (tokens.has(key) && typeof value === 'string' && value.length < 150 && CSS.supports(key === 'radius' ? 'border-radius' : 'color', value)) document.documentElement.style.setProperty('--' + key, value);
    }
  });
  document.addEventListener('input', () => window.parent.postMessage({type:'bg-v2-preview-edited'}, location.origin));
  window.parent.postMessage({type:'bg-v2-theme-ready'}, location.origin);
})();
