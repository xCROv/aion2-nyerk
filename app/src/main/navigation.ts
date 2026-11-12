/**
 * Where a window may go by itself (will-navigate): nowhere but a reload of the page it shows. The
 * app's own loads are loadFile and loadURL, which never ask; whatever does ask, a link or a file
 * dropped on the window, would open another page with the app's bridge in it. (No Electron import
 * here, so the tests can run it.)
 */
const withoutHash = (url: string): string => url.replace(/#.*/, '')

export function mayNavigate(to: string, from: string): boolean {
  return withoutHash(to) === withoutHash(from)
}
