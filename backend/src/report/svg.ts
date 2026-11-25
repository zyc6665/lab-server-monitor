/**
 * 1:1 port of `render_svg_line_chart` (`servermanage/report.py:385-451`).
 *
 * The output is byte-for-byte identical to CPython's f-string rendering, which
 * means coordinates must be formatted exactly like `str(float)` / `repr(float)`
 * (`36.0`, not `36`; `1e+20`, not `100000000000000000000`). JavaScript's
 * `Number.prototype.toString` uses different thresholds, so {@link
 * pythonFloatRepr} re-implements CPython's `float_repr` layout:
 *
 * - shortest round-trip digits (via `toExponential()`),
 * - fixed notation when the decimal exponent is in `[-4, 16)`,
 * - scientific notation otherwise (`d.ddd e±NN`, exponent padded to >= 2 digits),
 * - integral values always carry a trailing `.0`.
 */

export interface SvgChartOptions {
  width?: number;
  height?: number;
  title?: string;
  yMax?: number;
}

/**
 * Format a finite double exactly like Python's `repr(float)` / `str(float)`.
 *
 * Only finite values are expected here (chart coordinates); non-finite values
 * fall back to Python's textual spellings.
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (value === Infinity) {
    return 'inf';
  }
  if (value === -Infinity) {
    return '-inf';
  }
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (magnitude === 0) {
    return negative ? '-0.0' : '0.0';
  }

  // `toExponential()` without an argument yields the shortest round-trip
  // mantissa, e.g. 69.33333333333333 -> "6.933333333333333e+1".
  const [mantissaText, exponentText] = magnitude.toExponential().split('e');
  const exponent = Number.parseInt(exponentText, 10);
  const digits = mantissaText.replace('.', '');
  // value == 0.<digits> * 10^decimalPoint
  const decimalPoint = exponent + 1;

  let body: string;
  if (decimalPoint <= -4 || decimalPoint > 16) {
    const head = digits[0];
    const tail = digits.slice(1);
    const coefficient = tail.length > 0 ? `${head}.${tail}` : head;
    const sign = exponent < 0 ? '-' : '+';
    const absExponent = Math.abs(exponent).toString().padStart(2, '0');
    body = `${coefficient}e${sign}${absExponent}`;
  } else if (decimalPoint <= 0) {
    body = `0.${'0'.repeat(-decimalPoint)}${digits}`;
  } else if (decimalPoint >= digits.length) {
    body = `${digits}${'0'.repeat(decimalPoint - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
  }
  return negative ? `-${body}` : body;
}

/** Python's `int(float)` truncates toward zero. */
function pythonInt(value: number): number {
  return Math.trunc(value);
}

/**
 * Port of `servermanage/report.py:385-451`.
 *
 * @param dataPoints `[label, value]` pairs; `null` values are dropped (Python
 *   `if value is not None`). Fewer than two remaining points yields the
 *   "数据不足" placeholder SVG.
 */
export function renderSvgLineChart(
  dataPoints: ReadonlyArray<readonly [string, number | null]>,
  options: SvgChartOptions = {},
): string {
  const width = options.width ?? 360;
  const height = options.height ?? 120;
  const title = options.title ?? '';
  const initialYMax = options.yMax ?? 100.0;

  const points: Array<[string, number]> = [];
  for (const [label, value] of dataPoints) {
    if (value !== null) {
      points.push([label, Number(value)]);
    }
  }

  if (points.length < 2) {
    const fallbackTitle = title || 'Chart';
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" font-size="12" fill="#888">${fallbackTitle}: 数据不足</text></svg>`;
  }

  const paddingLeft = 36;
  const paddingRight = 12;
  const paddingTop = 24;
  const paddingBottom = 28;
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const xStep = chartWidth / (points.length - 1);
  const yMax = Math.max(initialYMax, ...points.map(([, value]) => value));

  const x = (index: number): number => paddingLeft + index * xStep;
  const y = (value: number): number => paddingTop + chartHeight - (value / yMax) * chartHeight;

  const pathPoints = points
    .map(([, value], index) => `${pythonFloatRepr(x(index))},${pythonFloatRepr(y(value))}`)
    .join(' ');
  const polyline = `<polyline fill="none" stroke="#3b82f6" stroke-width="2" points="${pathPoints}" />`;

  const circlePoints = points
    .map(
      ([, value], index) =>
        `<circle cx="${pythonFloatRepr(x(index))}" cy="${pythonFloatRepr(y(value))}" r="2.5" fill="#2563eb" />`,
    )
    .join('\n');

  const xLabels = points
    .map(
      ([label], index) =>
        `<text x="${pythonFloatRepr(x(index))}" y="${height - 8}" text-anchor="middle" font-size="9" fill="#666">${label.length >= 5 ? label.slice(5) : label}</text>`,
    )
    .join('\n');

  const yTicks = [0, yMax / 2, yMax];
  const yLabels = yTicks
    .map(
      (value) =>
        `<text x="${paddingLeft - 6}" y="${pythonFloatRepr(y(value) + 4)}" text-anchor="end" font-size="9" fill="#666">${pythonInt(value)}</text>`,
    )
    .join('\n');
  const gridLines = yTicks
    .map(
      (value) =>
        `<line x1="${paddingLeft}" y1="${pythonFloatRepr(y(value))}" x2="${width - paddingRight}" y2="${pythonFloatRepr(y(value))}" stroke="#e5e7eb" stroke-width="1" />`,
    )
    .join('\n');

  const axes =
    `\n    <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${height - paddingBottom}" stroke="#9ca3af" stroke-width="1" />` +
    `\n    <line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}" stroke="#9ca3af" stroke-width="1" />` +
    `\n    `;

  const titleText = title
    ? `<text x="${paddingLeft}" y="16" font-size="11" font-weight="bold" fill="#374151">${title}</text>`
    : '';

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="font-family: ui-sans-serif, system-ui, sans-serif;">\n    ${titleText}\n    ${gridLines}\n    ${axes}\n    ${yLabels}\n    ${xLabels}\n    ${polyline}\n    ${circlePoints}\n</svg>\n`;
}
