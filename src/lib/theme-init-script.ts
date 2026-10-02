// Must stay byte-identical between this module and the rendered <script> so the
// CSP sha256 hash computed by the middleware keeps matching. Avoid "*/" and
// "</script>" sequences on purpose.
export const THEME_INIT_SCRIPT = [
    '(function(){try{',
    'var t=localStorage.getItem("theme");',
    'if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){',
    'document.documentElement.classList.add("dark")',
    '}',
    '}catch(e){}',
    '})();',
].join('');
