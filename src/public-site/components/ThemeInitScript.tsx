import snapshot from '@/public-site/snapshot';

const themeScript = '(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})();';

export function ThemeInitScript() {
    return <script dangerouslySetInnerHTML={{ __html: themeScript }} data-static-csp-hash={snapshot.releaseId} />;
}
