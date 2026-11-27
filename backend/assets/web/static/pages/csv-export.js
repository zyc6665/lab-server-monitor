/* CSV 导出：把「取数据」与「拼 CSV / 触发下载」分离，便于单测与复用。 */

export function csvCell(value) {
  var text = value === null || value === undefined ? '' : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

/** rows: array of arrays of already-stringified cells. Returns { text, count }. */
export function buildCsv(headers, rows) {
  var lines = [(headers || []).map(csvCell).join(',')];
  (rows || []).forEach(function (row) {
    lines.push((row || []).map(csvCell).join(','));
  });
  return { text: lines.join('\r\n'), count: (rows || []).length };
}

export function downloadTextFile(filename, text, mime, opts) {
  var doc = (opts && opts.document) || document;
  var BlobCtor = (opts && opts.Blob) || Blob;
  var UrlApi = (opts && opts.URL) || URL;
  var blob = new BlobCtor(['\ufeff' + text], { type: mime || 'text/csv;charset=utf-8' });
  var url = UrlApi.createObjectURL(blob);
  var link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  UrlApi.revokeObjectURL(url);
}
