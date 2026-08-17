// The ONE DOM-poking module in this scope (4.5 W4), deliberately isolated so
// nothing else needs to know how a browser saves a file.
//
// There is no download without the DOM: a Blob has to become an object URL and a
// synthetic anchor has to be clicked. Keeping that in a single four-line function
// is what keeps the data layer and the screen free of it.

/**
 * Save a Blob under `filename` via a synthetic `<a download>` click.
 *
 * The revoke is deferred to the NEXT MACROTASK on purpose: revoking the object
 * URL in the same tick races the browser's download start and can produce an
 * empty or failed save in some browsers.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Appended because Firefox ignores a click on a detached anchor.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
