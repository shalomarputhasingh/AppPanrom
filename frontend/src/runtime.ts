import runtimeSource from '../../runtime/apppanrom-runtime.js?raw';

/**
 * Returns the AppPanrom runtime as a global. The runtime is a dependency-free UMD file that is also embedded verbatim in
 * the preview iframe and in APKs, so the Studio installs that exact source as a classic script instead of importing it
 * through the bundler (which would wrap it as CommonJS and hide the global).
 */
export function getRuntime() {
  if (!window.AppPanrom) {
    const s = document.createElement('script');
    s.textContent = runtimeSource;
    document.head.appendChild(s);
    s.remove();
  }
  return window.AppPanrom;
}
