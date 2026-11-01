// Draws the profile's contribution chart, one candle per week, in light and dark.
// Run by .github/workflows/chart.yml every six hours with LOGIN and GITHUB_TOKEN set.
import { mkdir, writeFile } from 'node:fs/promises';

const LOGIN = process.env.LOGIN;
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = 'dist';
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;

// One loop: the candles print left to right, the chart holds, then it fades out and prints again.
const CYCLE = 16; // seconds
const DRAW_START = 3; // % of the loop when the first candle prints
const DRAW_END = 55; // % of the loop when the last candle prints

const W = 880,
	H = 316,
	PAD = 24;

const THEMES = {
	light: {
		card: '#f6f8fa',
		edge: '#d1d9e0',
		grid: '#e3e7eb',
		ink: '#1f2328',
		muted: '#59636e',
		up: '#089981',
		down: '#f23645',
		average: '#1d00e5',
	},
	dark: {
		card: '#151b23',
		edge: '#3d444d',
		grid: '#232a33',
		ink: '#f0f6fc',
		muted: '#9198a1',
		up: '#26a69a',
		down: '#f7525f',
		average: '#8b7dff',
	},
};

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const f1 = (n) => n.toFixed(1);
const esc = (s) =>
	String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function github(query, variables) {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: {
			authorization: `bearer ${TOKEN}`,
			'content-type': 'application/json',
			'user-agent': 'contribution-chart',
		},
		body: JSON.stringify({ query, variables }),
	});
	const body = await res.json();
	if (!res.ok || body.errors) throw new Error(`GitHub API: ${JSON.stringify(body.errors ?? body)}`);
	return body.data;
}

// The last 365 days, oldest first. GitHub caps one contributions query at a year.
async function contributions(login) {
	const to = new Date();
	const from = new Date(to.getTime() - 364 * DAY);
	const data = await github(
		`query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) { name
      contributionsCollection(from: $from, to: $to) { contributionCalendar {
      weeks { contributionDays { date contributionCount } } } } } }`,
		{ from: from.toISOString(), login, to: to.toISOString() },
	);
	const days = data.user.contributionsCollection.contributionCalendar.weeks
		.flatMap((w) => w.contributionDays)
		.map((d) => ({ count: d.contributionCount, date: d.date }))
		.sort((a, b) => a.date.localeCompare(b.date));
	return { days, name: data.user.name || login };
}

// The "price" is the rolling seven day total, so each weekly candle is a true open, high, low and
// close of that series, with the last candle ending today. Empty weeks before the first
// contribution are trimmed, keeping at least 12 weeks on screen.
function weekly(days) {
	const price = days.map((_, i) =>
		days.slice(Math.max(0, i - 6), i + 1).reduce((sum, d) => sum + d.count, 0),
	);
	const weeks = [];
	for (let end = days.length - 1; end >= 13; end -= 7) {
		const start = end - 6;
		const span = price.slice(start - 1, end + 1);
		weeks.unshift({
			active: days.slice(start, end + 1).filter((d) => d.count > 0).length,
			close: price[end],
			high: Math.max(...span),
			low: Math.min(...span),
			open: price[start - 1],
			start: days[start].date,
		});
	}
	const first = weeks.findIndex((w) => w.high > 0);
	const from = first === -1 ? weeks.length - 12 : Math.min(first - 1, weeks.length - 12);
	return weeks.slice(Math.max(0, from));
}

// Whole-number gridlines, about four of them.
function axis(max) {
	const raw = Math.max(max, 4) / 4;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw && Number.isInteger(s));
	return { step, top: Math.ceil(Math.max(max, 1) / step) * step };
}

function chart({ name, days }, theme) {
	const t = THEMES[theme];
	const weeks = weekly(days);
	const n = weeks.length;
	const last = weeks.at(-1);
	const total = days.reduce((sum, d) => sum + d.count, 0);
	const lastUp = last.close >= last.open;
	const lastColour = lastUp ? t.up : t.down;

	const left = PAD,
		right = W - PAD - 44,
		top = 112,
		bottom = 250,
		volumeTop = 256,
		volumeBottom = 278;
	const { step: tick, top: max } = axis(Math.max(...weeks.map((w) => w.high)));
	const y = (v) => bottom - (v / max) * (bottom - top);
	const slot = (right - left) / n;
	const x = (i) => left + slot * (i + 0.5);
	const body = Math.max(2, slot * 0.62);
	const at = (i) => DRAW_START + (n > 1 ? (i / (n - 1)) * (DRAW_END - DRAW_START) : 0);
	const grow = Math.max(1.2, ((DRAW_END - DRAW_START) / n) * 1.8);

	// Header: name and yearly total on the left, four stats on the right.
	const change =
		last.open > 0
			? `${lastUp ? '▲' : '▼'} ${Math.abs(((last.close - last.open) / last.open) * 100).toFixed(0)}%`
			: last.close > 0
				? '▲ new'
				: '0%';
	const stats = [
		['Last 7 days', `${fmt(last.close)}<tspan dx="6" font-size="12" fill="${lastColour}">${change}</tspan>`],
		['Best week', fmt(Math.max(...weeks.map((w) => w.close)))],
		['Best day', fmt(Math.max(...days.map((d) => d.count)))],
		['Active days', fmt(days.filter((d) => d.count > 0).length)],
	]
		.map(([label, value], k, all) => {
			const sx = W - PAD - (all.length - 1 - k) * 104;
			return `<text x="${sx}" y="42" text-anchor="end" font-size="12" fill="${t.muted}">${label}</text>
    <text x="${sx}" y="66" text-anchor="end" font-size="18" font-weight="600" fill="${t.ink}">${value}</text>`;
		})
		.join('\n    ');
	const header = `<text x="${PAD}" y="42" font-size="14" font-weight="600" fill="${t.ink}">${esc(name)}<tspan font-weight="400" fill="${t.muted}"> · Contributions · 1W</tspan></text>
    <text x="${PAD}" y="84" font-size="34" font-weight="700" letter-spacing="-.5" fill="${t.ink}">${fmt(total)}<tspan dx="8" font-size="14" font-weight="400" letter-spacing="0" fill="${t.muted}">contributions in the last year</tspan></text>
    ${stats}`;

	let grid = '';
	for (let v = 0; v <= max; v += tick) {
		grid += `<line x1="${left}" x2="${right}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="${t.grid}"/>
    <text x="${W - PAD}" y="${f1(y(v) + 4)}" text-anchor="end" font-size="11" fill="${t.muted}">${fmt(v)}</text>`;
	}

	let months = '',
		lastMonth = '',
		lastLabelX = -Infinity;
	weeks.forEach((w, i) => {
		const month = MONTHS[+w.start.slice(5, 7) - 1];
		if (month === lastMonth) return;
		lastMonth = month;
		const mx = x(i) - slot / 2;
		if (mx - lastLabelX < 30) return;
		lastLabelX = mx;
		months += `<text x="${f1(mx)}" y="${H - 16}" font-size="11" fill="${t.muted}">${month}</text>`;
	});

	// Each candle grows out of its open price at its moment in the loop, like a live candle printing.
	let keys = '',
		candles = '',
		volume = '';
	weeks.forEach((w, i) => {
		const colour = w.close >= w.open ? t.up : t.down;
		const cx = x(i);
		const bodyTop = y(Math.max(w.open, w.close));
		const bodyHeight = Math.max(1.2, y(Math.min(w.open, w.close)) - bodyTop);
		const a = at(i);
		keys += `@keyframes c${i}{0%,${a.toFixed(2)}%{transform:scaleY(0);opacity:0}${(a + grow).toFixed(2)}%,100%{transform:scaleY(1);opacity:1}}`;
		const animation = `animation:c${i} ${CYCLE}s cubic-bezier(.2,.8,.2,1) infinite`;
		candles += `<g style="transform-origin:${f1(cx)}px ${f1(y(w.open))}px;${animation}"><line x1="${f1(cx)}" x2="${f1(cx)}" y1="${f1(y(w.high))}" y2="${f1(y(w.low))}" stroke="${colour}" stroke-width="1.2"/><rect x="${f1(cx - body / 2)}" y="${f1(bodyTop)}" width="${f1(body)}" height="${f1(bodyHeight)}" rx="1" fill="${colour}"/></g>`;
		// Volume is how many of the week's seven days had a contribution.
		if (w.active === 0) return;
		const vh = (w.active / 7) * (volumeBottom - volumeTop);
		volume += `<rect x="${f1(cx - body / 2)}" y="${f1(volumeBottom - vh)}" width="${f1(body)}" height="${f1(vh)}" rx="1" fill="${colour}" fill-opacity=".25" style="transform-origin:${f1(cx)}px ${volumeBottom}px;${animation}"/>`;
	});

	// Four week moving average, revealed in step with the candles.
	const average = weeks.map((_, i) => {
		const window = weeks.slice(Math.max(0, i - 3), i + 1);
		return window.reduce((sum, w) => sum + w.close, 0) / window.length;
	});
	const averagePath = average.map((v, i) => `${i ? 'L' : 'M'}${f1(x(i))},${f1(y(v))}`).join(' ');
	const reveal = `<clipPath id="reveal"><rect width="${right}" height="${H}"><animate attributeName="width" dur="${CYCLE}s" repeatCount="indefinite" values="${f1(x(0))};${f1(x(0))};${f1(x(n - 1))};${right};${right}" keyTimes="0;${DRAW_START / 100};${DRAW_END / 100};${(DRAW_END + 1) / 100};1"/></rect></clipPath>`;

	// Once the last candle prints: a dashed last-price line, its price tag, and a live dot.
	const ly = y(last.close);
	const lx = x(n - 1);
	const price = `<g style="animation:late ${CYCLE}s linear infinite">
      <line x1="${left}" x2="${right}" y1="${f1(ly)}" y2="${f1(ly)}" stroke="${lastColour}" stroke-width="1" stroke-dasharray="2 3"/>
      <rect x="${right + 4}" y="${f1(ly - 9)}" width="${W - PAD - right - 4}" height="18" rx="4" fill="${lastColour}"/>
      <text x="${W - PAD - 5}" y="${f1(ly + 4)}" text-anchor="end" font-size="11" font-weight="600" fill="#fff">${fmt(last.close)}</text>
      <circle cx="${f1(lx)}" cy="${f1(ly)}" r="3" fill="${lastColour}"/>
      <circle cx="${f1(lx)}" cy="${f1(ly)}" r="3" fill="none" stroke="${lastColour}" style="transform-origin:${f1(lx)}px ${f1(ly)}px;animation:ping 1.6s ease-out infinite"/>
    </g>`;

	const label = `${name}: ${fmt(total)} contributions in the last year, one candle per week`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
  <title>${esc(label)}</title>
  <style>
    text { font-family: ${FONT}; font-variant-numeric: tabular-nums; }
    ${keys}
    @keyframes late { 0%, ${DRAW_END}% { opacity: 0 } ${DRAW_END + 3}%, 100% { opacity: 1 } }
    @keyframes ping { 0% { transform: scale(1); opacity: .8 } 100% { transform: scale(4); opacity: 0 } }
    @keyframes cycle { 0%, 94% { opacity: 1 } 98.5%, 100% { opacity: 0 } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important } }
  </style>
  <defs>${reveal}</defs>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="16" fill="${t.card}" stroke="${t.edge}"/>
    ${header}
    ${grid}
    ${months}
  <g style="animation:cycle ${CYCLE}s linear infinite">
    ${volume}
    ${candles}
    <path d="${averagePath}" fill="none" stroke="${t.average}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#reveal)"/>
    ${price}
  </g>
</svg>
`;
}

if (!LOGIN || !TOKEN) throw new Error('Set LOGIN and GITHUB_TOKEN');
const data = await contributions(LOGIN);
await mkdir(OUT, { recursive: true });
for (const theme of Object.keys(THEMES)) {
	await writeFile(`${OUT}/chart-${theme}.svg`, chart(data, theme));
}
console.log(`Drew ${data.days.length} days for ${LOGIN}`);
