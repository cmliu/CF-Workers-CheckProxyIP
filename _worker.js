const DEFAULT_BEIAN_CONTENT = `© 2025 - 2026 Check ProxyIP · 基于 <a href="https://github.com/cmliu/CF-Workers-CheckProxyIP" target="_blank" rel="noreferrer">Cloudflare Workers 构建与运行</a> · 今日访问人数：<span id="visit-count">···</span> · 站点维护：<a href="https://t.me/CMLiussss" target="_blank" rel="noreferrer">CMLiussss</a>
<script>
(function () {
	const visitCountElement = document.getElementById('visit-count');
	if (!visitCountElement) return;

	const hostname = String(window.location.hostname || window.location.host || '').trim().toLowerCase();
	const statsId = hostname || 'unknown-host';

	fetch('https://tongji.090227.xyz/?id=' + encodeURIComponent(statsId))
		.then(function (response) {
			if (!response.ok) throw new Error('Failed to load visit count: ' + response.status);
			return response.json();
		})
		.then(function (data) {
			if (data && data.visitCount !== undefined) {
				visitCountElement.textContent = data.visitCount;
				return;
			}
			throw new Error('visitCount is missing in response');
		})
		.catch(function (error) {
			console.error('Failed to fetch visit count', error);
			visitCountElement.textContent = '加载失败';
		});
})();
</script>`;
const RESOLVE_BATCH_LIMIT = 15;

// 把 env.API_HOST 归一化成 scheme://host[:port]，用于前端 /check 与 /cdn-cgi/trace 的请求地址。
// 未配置（undefined/空串/纯空格）时回退页面当前源，保留 scheme 与端口（wrangler dev 可用）；
// 带 scheme 则保留，否则默认 https；只接受 http/https。
// 宿主名还需通过白名单：WHATWG URL 会接受 a'+(...)+' 这类含单引号的宿主名，
// 直接拼进内联脚本单引号字符串会破坏语法，所以必须显式收紧。
function resolveApiBase(value, requestUrl) {
	const fallback = requestUrl.origin;
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return fallback;

	try {
		const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
		const hostOk = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)$/.test(parsed.hostname);
		if (!/^https?:$/.test(parsed.protocol) || !hostOk) throw new Error('invalid host or scheme');
		if (parsed.pathname !== '/') console.warn('[API_HOST] 路径前缀不支持，已忽略：', parsed.pathname);
		return parsed.origin;
	} catch (error) {
		console.warn('[API_HOST] 非法值，已回退为页面同源：', raw, error.message);
		return fallback;
	}
}

export default {
	async fetch(request, env) {
		const 备案内容 = env.BEIAN ?? DEFAULT_BEIAN_CONTENT;
		const url = new URL(request.url);
		// 仅用于前端 `/check` 与 `/cdn-cgi/trace` 的请求基地址，其它接口保持页面同源相对路径。
		const apiBase = resolveApiBase(env.API_HOST, url);

		if (url.pathname === '/check') {
			return handleCheckProxyRequest(request);
		} else if (url.pathname === '/resolve') {
			const proxyip = url.searchParams.get('proxyip');
			if (!proxyip) {
				return new Response('Missing proxyip', { status: 400 });
			}

			try {
				const targets = await handleResolve(proxyip);
				return new Response(JSON.stringify(targets), {
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: error.message }), {
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}
		} else if (url.pathname === '/resolve-batch') {
			return handleResolveBatchRequest(request);
		} else if (url.pathname === '/locations') return fetch(new Request('https://speed.cloudflare.com/locations', { headers: { 'Referer': 'https://speed.cloudflare.com/' } }));
		return new Response(generateHTML(备案内容, apiBase), {
			headers: { 'Content-Type': 'text/html; charset=UTF-8' }
		});
	}
};

async function handleResolveBatchRequest(request) {
	const headers = {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type'
	};

	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers
		});
	}

	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Method not allowed' }), {
			status: 405,
			headers: {
				...headers,
				'Allow': 'POST, OPTIONS'
			}
		});
	}

	let payload;
	try {
		payload = await request.json();
	} catch (error) {
		return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
			status: 400,
			headers
		});
	}

	const inputs = getResolveBatchInputs(payload);
	if (!inputs.length) {
		return new Response(JSON.stringify({ error: 'Missing targets' }), {
			status: 400,
			headers
		});
	}

	if (inputs.length > RESOLVE_BATCH_LIMIT) {
		return new Response(JSON.stringify({ error: `Resolve batch limit is ${RESOLVE_BATCH_LIMIT}` }), {
			status: 400,
			headers
		});
	}

	const results = await Promise.all(inputs.map(async input => {
		try {
			return {
				input,
				targets: await handleResolve(input)
			};
		} catch (error) {
			return {
				input,
				targets: [],
				error: error.message
			};
		}
	}));

	return new Response(JSON.stringify({ results }), {
		headers
	});
}

function getResolveBatchInputs(payload) {
	const values = Array.isArray(payload?.targets)
		? payload.targets
		: (Array.isArray(payload?.proxyips) ? payload.proxyips : []);

	return uniqueStrings(values
		.map(value => String(value || '').trim())
		.filter(Boolean));
}

function uniqueStrings(values) {
	const seenValues = new Set();
	return values.filter(value => {
		if (seenValues.has(value)) return false;
		seenValues.add(value);
		return true;
	});
}

async function handleResolve(input) {
	let { host, port } = parseTarget(input);

	const tpPortMatch = host.toLowerCase().match(/\.tp(\d{1,5})\./);
	if (tpPortMatch) {
		const tpPort = Number(tpPortMatch[1]);
		if (tpPort >= 1 && tpPort <= 65535) {
			port = tpPort;
		}
	}

	const bracketedIPv6 = host.startsWith('[') && host.endsWith(']');
	const rawIPv6 = /^[0-9a-fA-F:]+$/.test(host);
	if (isIPv4(host) || bracketedIPv6 || rawIPv6) {
		const finalHost = rawIPv6 && !bracketedIPv6 ? `[${host}]` : host;
		return [`${finalHost}:${port}`];
	}

	const [txtRecords, aRecords, aaaaRecords] = await Promise.all([
		dohQuery(host, 'TXT'),
		dohQuery(host, 'A'),
		dohQuery(host, 'AAAA')
	]);

	const results = [];
	for (const record of txtRecords.filter(item => item.type === 16 && item.data)) {
		const value = normalizeTxtValue(record.data);
		for (const part of value.split(',')) {
			const candidate = part.trim();
			if (candidate) results.push(candidate);
		}
	}
	for (const record of aRecords.filter(item => item.type === 1 && item.data)) {
		results.push(`${record.data}:${port}`);
	}
	for (const record of aaaaRecords.filter(item => item.type === 28 && item.data)) {
		results.push(`[${record.data}]:${port}`);
	}

	if (!results.length) {
		throw new Error('Could not resolve domain');
	}

	return uniqueStrings(results);
}

function parseTarget(input) {
	let host = String(input || '').split('#')[0].trim();
	let port = 443;

	if (host.startsWith('[')) {
		const ipv6PortIndex = host.lastIndexOf(']:');
		if (ipv6PortIndex !== -1) {
			const maybePort = Number(host.slice(ipv6PortIndex + 2));
			if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
				port = maybePort;
				host = host.slice(0, ipv6PortIndex + 1);
			}
		}
		return { host, port };
	}

	const colonMatches = host.match(/:/g) || [];
	if (colonMatches.length === 1) {
		const separatorIndex = host.lastIndexOf(':');
		const maybePort = Number(host.slice(separatorIndex + 1));
		if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
			port = maybePort;
			host = host.slice(0, separatorIndex);
		}
	}

	return { host, port };
}

function isIPv4(value) {
	const parts = value.split('.');
	return parts.length === 4 && parts.every(part => {
		if (!/^\d{1,3}$/.test(part)) return false;
		const num = Number(part);
		return num >= 0 && num <= 255;
	});
}

function normalizeTxtValue(value) {
	const text = String(value ?? '').trim();
	if (text.startsWith('"') && text.endsWith('"')) {
		return text.slice(1, -1).replace(/\\"/g, '"');
	}
	return text.replace(/\\"/g, '"');
}

async function dohQuery(name, type, endpoint = 'https://cloudflare-dns.com/dns-query') {
	const startedAt = performance.now();

	try {
		const response = await fetch(
			`${endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
			{
				headers: {
					accept: 'application/dns-json'
				}
			}
		);

		if (!response.ok) {
			console.warn(`[DoH] ${name} ${type} failed with status ${response.status}`);
			return [];
		}

		const payload = await response.json();
		if (!Array.isArray(payload.Answer)) {
			console.log(`[DoH] ${name} ${type} returned 0 answers in ${(performance.now() - startedAt).toFixed(2)}ms`);
			return [];
		}

		const answers = payload.Answer.map(answer => ({
			name: answer.name || name,
			type: answer.type,
			TTL: answer.TTL,
			data: answer.type === 16 ? normalizeTxtValue(answer.data) : answer.data
		}));

		console.log(`[DoH] ${name} ${type} returned ${answers.length} answers in ${(performance.now() - startedAt).toFixed(2)}ms`);
		return answers;
	} catch (error) {
		console.error(`[DoH] ${name} ${type} error after ${(performance.now() - startedAt).toFixed(2)}ms`, error);
		return [];
	}
}

function generateHTML(备案内容, apiBase) {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="color-scheme" content="light dark">
	<title>Check ProxyIP</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
	<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
	<script>
		(function () {
			const storageKey = 'cf_proxy_theme';
			let theme = 'dark';
			try {
				const storedTheme = localStorage.getItem(storageKey);
				if (storedTheme === 'light' || storedTheme === 'dark') {
					theme = storedTheme;
				} else {
					theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
				}
			} catch (error) {
				theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
			}
			document.documentElement.dataset.theme = theme;
			document.documentElement.style.colorScheme = theme;
		})();
	</script>
	<style>
		:root {
			--bg-base: #07111d;
			--bg-deep: #0b1726;
			--panel: rgba(10, 24, 40, 0.78);
			--panel-strong: rgba(15, 31, 49, 0.92);
			--line: rgba(144, 180, 212, 0.18);
			--text: #edf7ff;
			--text-soft: #d4e4f3;
			--muted: #8ea6bc;
			--accent: #61dbff;
			--accent-strong: #2dd4bf;
			--accent-warm: #ffb869;
			--success: #34d399;
			--error: #fb7185;
			--warning: #fbbf24;
			--shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
			--shadow-soft: 0 16px 44px rgba(0, 0, 0, 0.26);
			--radius-xl: 30px;
			--radius-lg: 24px;
			--radius-md: 20px;
		}

		html {
			color-scheme: dark;
		}

		html[data-theme='light'] {
			color-scheme: light;
			--bg-base: #eef6fb;
			--bg-deep: #ffffff;
			--panel: rgba(255, 255, 255, 0.72);
			--panel-strong: rgba(255, 255, 255, 0.92);
			--line: rgba(95, 123, 150, 0.18);
			--text: #10253d;
			--text-soft: #23415a;
			--muted: #61778f;
			--accent: #0ea5e9;
			--accent-strong: #14b8a6;
			--accent-warm: #f59e0b;
			--success: #059669;
			--error: #e11d48;
			--warning: #d97706;
			--shadow: 0 24px 64px rgba(43, 67, 91, 0.14);
			--shadow-soft: 0 16px 34px rgba(43, 67, 91, 0.1);
		}

		* {
			box-sizing: border-box;
		}

		html, body {
			margin: 0;
			min-height: 100%;
		}

		body {
			font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
			color: var(--text);
			background:
				radial-gradient(circle at top left, rgba(45, 212, 191, 0.18), transparent 28%),
				radial-gradient(circle at 85% 12%, rgba(97, 219, 255, 0.18), transparent 24%),
				radial-gradient(circle at 50% 110%, rgba(255, 184, 105, 0.16), transparent 30%),
				linear-gradient(180deg, #06101b 0%, #081321 38%, #0a1624 100%);
			overflow-x: hidden;
			transition: background 0.28s ease, color 0.28s ease;
		}

		body::before {
			content: '';
			position: fixed;
			inset: 0;
			pointer-events: none;
			background-image:
				linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
				linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
			background-size: 46px 46px;
			mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.38), transparent 92%);
			opacity: 0.12;
		}

		html[data-theme='light'] body {
			background:
				radial-gradient(circle at top left, rgba(20, 184, 166, 0.16), transparent 30%),
				radial-gradient(circle at 88% 12%, rgba(14, 165, 233, 0.14), transparent 24%),
				radial-gradient(circle at 50% 110%, rgba(245, 158, 11, 0.12), transparent 28%),
				linear-gradient(180deg, #f6fbff 0%, #eef5fb 44%, #e8f1f7 100%);
		}

		html[data-theme='light'] body::before {
			background-image:
				linear-gradient(rgba(16, 37, 61, 0.05) 1px, transparent 1px),
				linear-gradient(90deg, rgba(16, 37, 61, 0.05) 1px, transparent 1px);
			mask-image: linear-gradient(180deg, rgba(255, 255, 255, 0.68), transparent 92%);
			opacity: 0.28;
		}

		button,
		input,
		select,
		textarea {
			font: inherit;
		}

		body,
		.surface-card,
		.input-control,
		.history-toggle,
		.history-dropdown,
		.mode-card,
		.progress-container,
		.metric-card,
		.results-pill,
		.results-empty,
		.results-filters,
		.filter-toggle,
		.filter-panel,
		.filter-chip,
		.filter-empty,
		.empty-visual,
		.guide-card,
		.guide-flow,
		.guide-step,
		.guide-tip,
		.proxy-search-shell,
		.proxy-search-control,
		.result-item,
		.status-badge,
		.meta-chip,
		.exit-ip-card,
		.map-container-wrapper,
		.theme-toggle {
			transition: background 0.28s ease, border-color 0.28s ease, color 0.28s ease, box-shadow 0.28s ease, opacity 0.28s ease;
		}

		.page-shell {
			position: relative;
			min-height: 100vh;
			padding: 32px 24px 40px;
		}

		.ambient {
			position: fixed;
			border-radius: 999px;
			filter: blur(80px);
			pointer-events: none;
			z-index: 0;
			opacity: 0.28;
		}

		.ambient-one {
			width: 34rem;
			height: 34rem;
			left: -9rem;
			top: 10rem;
			background: rgba(97, 219, 255, 0.22);
		}

		.ambient-two {
			width: 28rem;
			height: 28rem;
			right: -6rem;
			top: -3rem;
			background: rgba(45, 212, 191, 0.18);
		}

		html[data-theme='light'] .ambient-one {
			background: rgba(56, 189, 248, 0.2);
		}

		html[data-theme='light'] .ambient-two {
			background: rgba(45, 212, 191, 0.16);
		}

		.site-header,
		.site-main,
		.site-footer {
			position: relative;
			z-index: 1;
			max-width: 1200px;
			margin: 0 auto;
		}

		.site-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 24px;
			margin-bottom: 24px;
		}

		.brand {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.brand-chip {
			display: inline-flex;
			align-items: center;
			justify-content: space-between;
			gap: 14px;
			align-self: flex-start;
			padding: 8px 10px 8px 14px;
			border-radius: 999px;
			border: 1px solid rgba(97, 219, 255, 0.16);
			background: rgba(12, 26, 43, 0.66);
			color: #bfeeff;
			font-size: 0.78rem;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			backdrop-filter: blur(12px);
		}

		.brand-chip-text {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			min-width: 0;
		}

		.brand-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: linear-gradient(135deg, var(--accent), var(--accent-strong));
			box-shadow: 0 0 18px rgba(97, 219, 255, 0.7);
		}

		.brand-title {
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			font-size: clamp(1.7rem, 4vw, 2.75rem);
			font-weight: 700;
			line-height: 0.98;
			letter-spacing: -0.04em;
			text-transform: uppercase;
			color: #f7fbff;
			text-wrap: balance;
		}

		.header-note {
			max-width: 420px;
			color: var(--muted);
			line-height: 1.7;
			text-align: right;
			flex: 0 1 420px;
		}

		.theme-toggle {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			border: none;
			border-radius: 0;
			background: transparent;
			color: var(--text);
			box-shadow: none;
			backdrop-filter: none;
			cursor: pointer;
			min-width: 0;
			transition: color 0.28s ease;
		}

		.theme-toggle:hover {
			transform: none;
		}

		.theme-toggle:focus-visible {
			outline: none;
		}

		.theme-toggle-switch {
			position: relative;
			width: 56px;
			height: 30px;
			flex: none;
			border-radius: 999px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.18), rgba(45, 212, 191, 0.12));
			box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
			transition: transform 0.2s ease, background 0.28s ease, border-color 0.28s ease, box-shadow 0.28s ease;
		}

		.theme-toggle:hover .theme-toggle-switch {
			transform: translateY(-1px);
			border-color: rgba(97, 219, 255, 0.2);
			box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
		}

		.theme-toggle:focus-visible .theme-toggle-switch {
			box-shadow: 0 0 0 4px rgba(97, 219, 255, 0.12), 0 10px 24px rgba(0, 0, 0, 0.18);
		}

		.theme-toggle-icon {
			position: absolute;
			top: 9px;
			width: 12px;
			height: 12px;
			color: rgba(255, 255, 255, 0.72);
			pointer-events: none;
		}

		.theme-toggle-icon-light {
			left: 8px;
			color: #ffd97d;
		}

		.theme-toggle-icon-dark {
			right: 8px;
			color: #d9efff;
		}

		.theme-toggle-thumb {
			position: absolute;
			top: 3px;
			left: 3px;
			width: 22px;
			height: 22px;
			border-radius: 50%;
			background: linear-gradient(135deg, #ffffff, #d9e9f7);
			box-shadow: 0 6px 14px rgba(0, 0, 0, 0.24);
			transform: translateX(28px);
			transition: transform 0.28s ease, background 0.28s ease, box-shadow 0.28s ease;
		}

		html[data-theme='light'] .theme-toggle-thumb {
			transform: translateX(0);
			background: linear-gradient(135deg, #fff9d9, #ffd88a);
			box-shadow: 0 8px 16px rgba(168, 116, 23, 0.18);
		}

		html[data-theme='light'] .theme-toggle-switch {
			border-color: rgba(84, 112, 139, 0.14);
			background: linear-gradient(135deg, rgba(254, 240, 138, 0.56), rgba(125, 211, 252, 0.34));
		}

		html[data-theme='light'] .theme-toggle-icon {
			color: #53708d;
		}

		html[data-theme='light'] .theme-toggle-icon-light {
			color: #d97706;
		}

		html[data-theme='light'] .theme-toggle-icon-dark {
			color: #2563eb;
		}

		.surface-card {
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 36%),
				var(--panel);
			border: 1px solid var(--line);
			border-radius: var(--radius-xl);
			box-shadow: var(--shadow);
			backdrop-filter: blur(18px);
		}

		.section-kicker {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			margin: 0 0 18px;
			font-size: 0.82rem;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: #9feaff;
		}

		.section-kicker::before {
			content: '';
			width: 26px;
			height: 1px;
			background: linear-gradient(90deg, transparent, rgba(97, 219, 255, 0.85));
		}

		.panel-copy,
		.field-hint,
		.summary-description,
		.results-subtitle,
		.empty-copy p,
		.site-footer {
			color: var(--muted);
			line-height: 1.8;
		}

		.summary-description,
		.empty-copy p {
			margin: 0;
		}

		.workspace-grid {
			display: grid;
			grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.9fr);
			gap: 24px;
			align-items: stretch;
			margin-top: 0;
			position: relative;
			z-index: 4;
		}

		.control-panel {
			padding: 30px;
			display: flex;
			flex-direction: column;
			min-height: 100%;
			position: relative;
			z-index: 5;
		}

		.panel-header,
		.results-header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 20px;
		}

		.panel-title,
		.summary-title,
		.results-title,
		.empty-copy h3 {
			margin: 0;
			font-size: 1.45rem;
			font-weight: 700;
			letter-spacing: -0.02em;
		}

		.panel-copy {
			margin: 10px 0 0;
			max-width: 58ch;
		}

		.panel-badge {
			padding: 10px 14px;
			border-radius: 999px;
			background: rgba(97, 219, 255, 0.08);
			border: 1px solid rgba(97, 219, 255, 0.16);
			color: #c6f5ff;
			font-size: 0.82rem;
			white-space: nowrap;
		}

		.input-zone {
			margin-top: 24px;
		}

		.field-label {
			display: block;
			margin-bottom: 12px;
			font-size: 0.9rem;
			font-weight: 600;
			color: #d9efff;
		}

		.input-wrapper {
			position: relative;
		}

		.input-control {
			width: 100%;
			padding: 18px 64px 18px 20px;
			border: 1px solid var(--line);
			border-radius: 22px;
			background: rgba(4, 14, 24, 0.52);
			color: var(--text);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
			transition: border-color 0.24s ease, box-shadow 0.24s ease, background 0.24s ease;
		}

		.input-control::placeholder {
			color: #7390a9;
		}

		.input-control:focus {
			outline: none;
			background: rgba(5, 18, 29, 0.74);
			border-color: rgba(97, 219, 255, 0.34);
			box-shadow: 0 0 0 4px rgba(97, 219, 255, 0.08);
		}

		textarea.input-control {
			min-height: 188px;
			resize: vertical;
			padding-right: 20px;
			line-height: 1.75;
		}

		.field-hint {
			margin: 12px 0 0;
			font-size: 0.9rem;
		}

		.history-toggle {
			position: absolute;
			right: 16px;
			top: 50%;
			transform: translateY(-50%);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 38px;
			height: 38px;
			border-radius: 14px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(255, 255, 255, 0.03);
			color: #b1c7db;
			cursor: pointer;
			transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
		}

		.history-toggle:hover {
			color: #f7fbff;
			background: rgba(97, 219, 255, 0.08);
			transform: translateY(calc(-50% - 1px));
		}

		.history-dropdown {
			position: absolute;
			top: calc(100% + 10px);
			left: 0;
			right: 0;
			display: none;
			padding: 8px;
			border-radius: 20px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(8, 19, 32, 0.96);
			box-shadow: 0 18px 42px rgba(0, 0, 0, 0.42);
			max-height: 280px;
			overflow-y: auto;
			z-index: 80;
		}

		.history-item {
			width: 100%;
			padding: 13px 14px;
			border: none;
			background: transparent;
			border-radius: 14px;
			color: var(--text-soft);
			text-align: left;
			cursor: pointer;
			transition: background 0.2s ease, color 0.2s ease;
		}

		.history-item:hover {
			background: rgba(97, 219, 255, 0.08);
			color: #ffffff;
		}

		.history-item.is-empty {
			color: #69839a;
			cursor: default;
		}

		.control-row {
			display: flex;
			gap: 16px;
			align-items: stretch;
			margin-top: 18px;
		}

		.mode-card {
			min-width: 238px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			padding: 18px 18px 18px 20px;
			border-radius: 22px;
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid rgba(255, 255, 255, 0.07);
		}

		.mode-copy strong {
			display: block;
			margin-bottom: 6px;
			font-size: 0.98rem;
		}

		.mode-state {
			font-size: 0.88rem;
			color: var(--muted);
		}

		.switch {
			position: relative;
			display: inline-block;
			width: 54px;
			height: 30px;
			flex: none;
		}

		.switch input {
			opacity: 0;
			width: 0;
			height: 0;
		}

		.slider {
			position: absolute;
			inset: 0;
			cursor: pointer;
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.12);
			border: 1px solid rgba(255, 255, 255, 0.08);
			transition: 0.28s ease;
		}

		.slider::before {
			content: '';
			position: absolute;
			width: 22px;
			height: 22px;
			left: 3px;
			top: 3px;
			border-radius: 50%;
			background: #ffffff;
			box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
			transition: 0.28s ease;
		}

		.switch input:checked + .slider {
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.92), rgba(45, 212, 191, 0.84));
			border-color: transparent;
		}

		.switch input:checked + .slider::before {
			transform: translateX(24px);
		}

		.primary-btn {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 4px;
			border: none;
			padding: 16px 20px;
			border-radius: 22px;
			background: linear-gradient(135deg, var(--accent), #8cf2ff 52%, var(--accent-warm));
			color: #052538;
			font-weight: 800;
			cursor: pointer;
			box-shadow: 0 18px 34px rgba(97, 219, 255, 0.28);
			transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
		}

		.primary-btn small {
			color: rgba(5, 37, 56, 0.78);
			font-size: 0.8rem;
			font-weight: 700;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.primary-btn:hover {
			transform: translateY(-2px);
			box-shadow: 0 24px 42px rgba(97, 219, 255, 0.34);
		}

		.primary-btn.is-stop {
			background: linear-gradient(135deg, #ef4444, #fb7185);
			color: #fff7f7;
			box-shadow: 0 18px 34px rgba(239, 68, 68, 0.28);
		}

		.primary-btn.is-stop small {
			color: rgba(255, 247, 247, 0.78);
		}

		.primary-btn.is-stop:hover {
			box-shadow: 0 24px 42px rgba(239, 68, 68, 0.34);
		}

		.primary-btn:disabled {
			cursor: wait;
			transform: none;
			opacity: 0.74;
			box-shadow: 0 14px 26px rgba(97, 219, 255, 0.18);
		}

		.progress-container {
			display: grid;
			gap: 10px;
			margin-top: 18px;
			padding: 16px;
			border-radius: 22px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.015)),
				rgba(255, 255, 255, 0.03);
		}

		.progress-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
			font-size: 0.92rem;
			color: var(--text-soft);
		}

		.progress-track {
			position: relative;
			height: 12px;
			border-radius: 999px;
			overflow: hidden;
			background: rgba(255, 255, 255, 0.08);
		}

		.progress-bar {
			width: 0%;
			height: 100%;
			border-radius: inherit;
			background: linear-gradient(90deg, var(--accent), var(--accent-strong), var(--accent-warm));
			transition: width 0.32s ease;
		}

		.side-column {
			display: grid;
			gap: 24px;
			min-height: 100%;
		}

		.side-card {
			padding: 30px;
			min-height: 100%;
		}

		.summary-card {
			position: relative;
			overflow: hidden;
			isolation: isolate;
		}

		.summary-card > * {
			position: relative;
			z-index: 1;
		}

		.summary-top {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 18px;
		}

		.summary-copy {
			flex: 1 1 auto;
			min-width: 0;
		}

		.summary-backend {
			display: flex;
			justify-content: flex-end;
			flex: 0 0 auto;
			max-width: 240px;
		}

		.summary-backend-badge {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 10px 14px;
			font-size: 0.75rem;
			font-weight: 700;
			line-height: 1.45;
			backdrop-filter: blur(14px);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
			white-space: normal;
			text-align: left;
		}

		.summary-backend-badge::before {
			content: '';
			width: 8px;
			height: 8px;
			border-radius: 999px;
			flex: 0 0 auto;
			background: currentColor;
			opacity: 0.9;
		}

		.summary-backend-badge.state-loading {
			background: rgba(97, 219, 255, 0.08);
			border-color: rgba(97, 219, 255, 0.18);
			color: #9feaff;
		}

		.summary-backend-badge.state-ready {
			background: rgba(16, 185, 129, 0.14);
			border-color: rgba(52, 211, 153, 0.28);
			color: #b7f7d0;
		}

		.summary-backend-badge.state-error {
			background: rgba(239, 68, 68, 0.12);
			border-color: rgba(248, 113, 113, 0.22);
			color: #fecaca;
		}

		.summary-flag-overlay {
			position: absolute;
			top: 68px;
			right: -18px;
			width: 156px;
			height: 104px;
			border-radius: 28px;
			background-position: center;
			background-repeat: no-repeat;
			background-size: cover;
			opacity: 0;
			filter: blur(13px) saturate(1.08);
			transform: rotate(7deg) scale(1.18);
			transform-origin: top right;
			pointer-events: none;
			z-index: 0;
			transition: opacity 0.24s ease;
		}

		.summary-card.has-backend-flag .summary-flag-overlay {
			opacity: 0.18;
		}

		.summary-description {
			margin-top: 10px;
		}

		.summary-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
			margin-top: 14px;
		}

		.metric-card {
			padding: 16px;
			border-radius: 18px;
			background: rgba(255, 255, 255, 0.03);
			border: 1px solid rgba(255, 255, 255, 0.06);
		}

		.metric-card span {
			display: block;
			margin-bottom: 6px;
			font-size: 0.82rem;
			color: var(--muted);
		}

		.metric-card strong {
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			font-size: 1.65rem;
			letter-spacing: -0.04em;
		}

		.results-shell {
			margin-top: 24px;
			padding: 28px;
			position: relative;
			z-index: 1;
		}

		.results-subtitle {
			margin: 10px 0 0;
		}

		.results-pill {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 10px 14px;
			border-radius: 999px;
			font-size: 0.82rem;
			font-weight: 700;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.04);
			color: #e8f5ff;
			white-space: nowrap;
		}

		.results-pill.state-idle {
			color: #d5e6f6;
		}

		.results-pill.state-resolving {
			background: rgba(251, 191, 36, 0.12);
			border-color: rgba(251, 191, 36, 0.22);
			color: #ffd97d;
		}

		.results-pill.state-running {
			background: rgba(97, 219, 255, 0.12);
			border-color: rgba(97, 219, 255, 0.24);
			color: #bff4ff;
		}

		.results-pill.state-done {
			background: rgba(52, 211, 153, 0.12);
			border-color: rgba(52, 211, 153, 0.24);
			color: #abffd8;
		}

		.results-pill.state-empty,
		.results-pill.state-error,
		.results-pill.state-stopped {
			background: rgba(251, 113, 133, 0.1);
			border-color: rgba(251, 113, 133, 0.22);
			color: #ffc4d0;
		}

		.results-empty {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 18px;
			align-items: center;
			padding: 24px;
			margin-top: 22px;
			margin-bottom: 18px;
			border-radius: 24px;
			border: 1px dashed rgba(144, 180, 212, 0.22);
			background: rgba(255, 255, 255, 0.025);
		}

		.results-filters[hidden],
		.filter-panel[hidden],
		.export-toast[hidden],
		.filter-empty[hidden] {
			display: none;
		}

		.results-filters {
			display: grid;
			gap: 12px;
			margin-top: 22px;
			margin-bottom: 18px;
		}

		.filter-toggle {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			width: 100%;
			min-height: 44px;
			padding: 10px 14px;
			border-radius: 18px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.04);
			color: var(--text-soft);
			font-weight: 800;
			cursor: pointer;
			text-align: left;
		}

		.filter-toggle:hover {
			border-color: rgba(97, 219, 255, 0.28);
			background: rgba(97, 219, 255, 0.08);
			color: #ffffff;
		}

		.filter-toggle-icon {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 18px;
			height: 18px;
			flex: none;
		}

		.filter-toggle-icon svg {
			display: block;
			width: 12px;
			height: 12px;
			overflow: visible;
			transform-origin: 50% 50%;
			transition: transform 0.2s ease;
		}

		.filter-toggle[aria-expanded='true'] .filter-toggle-icon svg {
			transform: rotate(180deg);
		}

		.filter-panel {
			display: grid;
			gap: 12px;
		}

		.filter-row {
			display: grid;
			grid-template-columns: max-content minmax(0, 1fr);
			gap: 10px;
			align-items: start;
		}

		.filter-row-label {
			color: var(--muted);
			font-size: 0.84rem;
			font-weight: 700;
			letter-spacing: 0.04em;
			line-height: 40px;
			white-space: nowrap;
		}

		.filter-options {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			min-width: 0;
		}

		.filter-chip {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 40px;
			padding: 9px 14px;
			border-radius: 999px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.04);
			color: var(--text-soft);
			font-size: 0.86rem;
			font-weight: 700;
			white-space: nowrap;
			cursor: pointer;
		}

		.filter-chip:hover {
			border-color: rgba(97, 219, 255, 0.28);
			background: rgba(97, 219, 255, 0.1);
			color: #ffffff;
		}

		.filter-chip.is-active {
			border-color: rgba(97, 219, 255, 0.46);
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.22), rgba(52, 211, 153, 0.14));
			color: #ffffff;
			box-shadow: inset 0 0 0 1px rgba(97, 219, 255, 0.12);
		}

		.export-chip {
			border-color: rgba(251, 191, 36, 0.28);
			background: linear-gradient(135deg, rgba(251, 191, 36, 0.18), rgba(255, 184, 105, 0.12));
			color: #ffe7a7;
		}

		.export-chip:hover {
			border-color: rgba(251, 191, 36, 0.48);
			background: linear-gradient(135deg, rgba(251, 191, 36, 0.26), rgba(255, 184, 105, 0.18));
			color: #fff4cf;
		}

		.filter-chip:disabled,
		.filter-chip.is-disabled {
			border-color: rgba(144, 180, 212, 0.1);
			background: rgba(255, 255, 255, 0.025);
			color: rgba(142, 166, 188, 0.46);
			box-shadow: none;
			cursor: not-allowed;
			opacity: 0.72;
			pointer-events: none;
		}

		.export-toast {
			position: fixed;
			left: 50%;
			bottom: 28px;
			z-index: 10000;
			max-width: min(420px, calc(100vw - 32px));
			padding: 12px 16px;
			border-radius: 999px;
			border: 1px solid rgba(97, 219, 255, 0.26);
			background: rgba(5, 18, 32, 0.94);
			box-shadow: 0 18px 44px rgba(0, 0, 0, 0.34);
			color: #e8fbff;
			font-size: 0.9rem;
			font-weight: 800;
			text-align: center;
			transform: translate(-50%, 12px);
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.22s ease, transform 0.22s ease;
		}

		.export-toast.is-visible {
			opacity: 1;
			transform: translate(-50%, 0);
		}

		.export-toast.is-error {
			border-color: rgba(251, 113, 133, 0.34);
			color: #ffd1d8;
		}

		.filter-empty {
			padding: 16px 18px;
			margin-bottom: 18px;
			border-radius: 18px;
			border: 1px dashed rgba(144, 180, 212, 0.22);
			background: rgba(255, 255, 255, 0.025);
			color: var(--muted);
			font-size: 0.92rem;
			line-height: 1.7;
		}

		.empty-visual {
			position: relative;
			width: 90px;
			height: 90px;
			border-radius: 26px;
			background:
				radial-gradient(circle at 30% 30%, rgba(97, 219, 255, 0.26), transparent 42%),
				linear-gradient(160deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015));
			border: 1px solid rgba(255, 255, 255, 0.06);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
		}

		.empty-visual span {
			position: absolute;
			border-radius: 999px;
		}

		.empty-visual span:nth-child(1) {
			width: 44px;
			height: 44px;
			left: 10px;
			top: 14px;
			background: rgba(97, 219, 255, 0.24);
		}

		.empty-visual span:nth-child(2) {
			width: 18px;
			height: 18px;
			right: 18px;
			top: 18px;
			background: rgba(45, 212, 191, 0.48);
		}

		.empty-visual span:nth-child(3) {
			width: 56px;
			height: 10px;
			left: 18px;
			bottom: 18px;
			background: rgba(255, 255, 255, 0.12);
		}

		.results-list {
			display: grid;
			gap: 16px;
		}

		.guide-shell {
			margin-top: 24px;
			padding: 28px;
			position: relative;
			overflow: hidden;
			z-index: 1;
		}

		.guide-shell::before {
			content: '';
			position: absolute;
			inset: 0;
			background:
				radial-gradient(circle at top right, rgba(97, 219, 255, 0.14), transparent 30%),
				radial-gradient(circle at bottom left, rgba(45, 212, 191, 0.12), transparent 28%);
			pointer-events: none;
		}

		.guide-header,
		.guide-grid,
		.guide-flow,
		.guide-tip {
			position: relative;
			z-index: 1;
		}

		.guide-header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 20px;
		}

		.guide-badge {
			display: inline-flex;
			align-items: center;
			align-self: flex-start;
			padding: 10px 14px;
			border-radius: 999px;
			background: rgba(97, 219, 255, 0.08);
			border: 1px solid rgba(97, 219, 255, 0.16);
			color: #c6f5ff;
			font-size: 0.82rem;
			font-weight: 600;
			white-space: nowrap;
		}

		.guide-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 16px;
			margin-top: 24px;
		}

		.guide-grid-secondary {
			margin-top: 18px;
		}

		.guide-card {
			padding: 24px;
			border-radius: 26px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 44%),
				rgba(8, 20, 34, 0.6);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
		}

		.guide-card-accent {
			background:
				radial-gradient(circle at top left, rgba(97, 219, 255, 0.16), transparent 38%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 46%),
				rgba(9, 22, 37, 0.68);
		}

		.guide-card-warm {
			background:
				radial-gradient(circle at top right, rgba(255, 184, 105, 0.16), transparent 34%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 46%),
				rgba(14, 23, 35, 0.72);
		}

		.guide-card-label {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 14px;
			font-size: 0.74rem;
			font-weight: 700;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: #9feaff;
		}

		.guide-card-label::before {
			content: '';
			width: 18px;
			height: 1px;
			background: rgba(97, 219, 255, 0.72);
		}

		.guide-card h3 {
			margin: 0;
			font-size: 1.18rem;
			line-height: 1.4;
			letter-spacing: -0.02em;
		}

		.guide-card p {
			margin: 14px 0 0;
			color: var(--muted);
			line-height: 1.8;
		}

		.guide-card a {
			color: #bff4ff;
			text-decoration: none;
			border-bottom: 1px solid rgba(191, 244, 255, 0.26);
		}

		.guide-card a:hover {
			color: #ffffff;
			border-bottom-color: rgba(255, 255, 255, 0.42);
		}

		.guide-quote {
			margin-top: 16px;
			padding: 14px 16px;
			border-radius: 20px;
			border: 1px solid rgba(251, 191, 36, 0.18);
			background: rgba(251, 191, 36, 0.1);
			color: #ffe7a7;
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			line-height: 1.6;
		}

		.guide-flow {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
			gap: 14px;
			align-items: center;
			margin-top: 18px;
			padding: 24px;
			border-radius: 28px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 60%),
				rgba(255, 255, 255, 0.03);
		}

		.guide-step {
			padding: 18px 16px;
			border-radius: 22px;
			text-align: center;
			border: 1px solid rgba(255, 255, 255, 0.07);
			background: rgba(255, 255, 255, 0.03);
		}

		.guide-step strong {
			display: block;
			font-size: 1rem;
			letter-spacing: -0.02em;
		}

		.guide-step span {
			display: block;
			margin-top: 8px;
			font-size: 0.9rem;
			color: var(--muted);
			line-height: 1.65;
		}

		.guide-step.is-source strong {
			color: #91ecff;
		}

		.guide-step.is-proxy strong {
			color: #8ef5d9;
		}

		.guide-step.is-target strong {
			color: #ffd08b;
		}

		.guide-arrow {
			font-size: 1.5rem;
			font-weight: 700;
			color: rgba(97, 219, 255, 0.82);
		}

		.guide-flow-caption {
			grid-column: 1 / -1;
			margin: 2px 0 0;
			text-align: center;
			color: var(--muted);
			line-height: 1.8;
		}

		.guide-list {
			margin: 14px 0 0;
			padding-left: 20px;
			color: var(--text-soft);
			line-height: 1.8;
		}

		.guide-list li + li {
			margin-top: 8px;
		}

		.guide-list li::marker {
			color: var(--accent-strong);
		}

		.guide-tip {
			margin-top: 18px;
			padding: 18px 20px;
			border-radius: 22px;
			border: 1px solid rgba(97, 219, 255, 0.16);
			background:
				linear-gradient(90deg, rgba(97, 219, 255, 0.1), rgba(45, 212, 191, 0.08), rgba(255, 184, 105, 0.08)),
				rgba(255, 255, 255, 0.02);
			color: #d7edf9;
			line-height: 1.8;
		}

		.guide-tip strong {
			color: #ffffff;
		}

		.proxy-search-shell {
			margin-top: 24px;
			padding: 28px;
			position: relative;
			overflow: hidden;
			z-index: 1;
		}

		.proxy-search-shell::before {
			content: '';
			position: absolute;
			inset: 0;
			background:
				radial-gradient(circle at top right, rgba(251, 191, 36, 0.12), transparent 30%),
				radial-gradient(circle at bottom left, rgba(97, 219, 255, 0.12), transparent 28%);
			pointer-events: none;
		}

		.proxy-search-header,
		.proxy-search-form {
			position: relative;
			z-index: 1;
		}

		.proxy-search-header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 20px;
		}

		.proxy-search-form {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-end;
			gap: 16px;
			margin-top: 24px;
		}

		.proxy-search-field {
			flex: 1 1 180px;
			min-width: 0;
		}

		.proxy-search-custom-field {
			flex: 0 1 170px;
		}

		.proxy-search-control {
			min-height: 58px;
			padding: 0 48px 0 18px;
			border-radius: 18px;
		}

		select.proxy-search-control {
			appearance: none;
			background-image:
				linear-gradient(45deg, transparent 50%, currentColor 50%),
				linear-gradient(135deg, currentColor 50%, transparent 50%);
			background-position:
				calc(100% - 23px) 50%,
				calc(100% - 17px) 50%;
			background-size: 6px 6px, 6px 6px;
			background-repeat: no-repeat;
			color: var(--text);
		}

		.proxy-search-input {
			padding-right: 18px;
			text-transform: uppercase;
		}

		.proxy-search-input:disabled {
			cursor: not-allowed;
			opacity: 0.72;
			color: var(--text-soft);
		}

		.proxy-search-btn {
			flex: 0 0 160px;
			min-height: 58px;
			border-radius: 18px;
			font-size: 1rem;
		}

		.result-item {
			position: relative;
			overflow: hidden;
			padding: 20px 22px;
			border-radius: 26px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 38%),
				var(--panel-strong);
			box-shadow: var(--shadow-soft);
		}

		.result-item > * {
			position: relative;
			z-index: 1;
		}

		.result-item::before {
			content: '';
			position: absolute;
			top: 0;
			left: 0;
			bottom: 0;
			width: 4px;
			background: rgba(147, 168, 189, 0.5);
		}

		.result-item.success::before {
			background: linear-gradient(180deg, #34d399, #10b981);
		}

		.result-item.error::before {
			background: linear-gradient(180deg, #fb7185, #ef4444);
		}

		.result-flag-overlay {
			position: absolute;
			top: 58px;
			right: -16px;
			width: 168px;
			height: 112px;
			border-radius: 28px;
			background-position: center;
			background-repeat: no-repeat;
			background-size: cover;
			opacity: 0;
			filter: blur(13px) saturate(1.08);
			transform: rotate(7deg) scale(1.18);
			transform-origin: top right;
			pointer-events: none;
			z-index: 0;
			transition: opacity 0.24s ease;
		}

		.result-item.success.has-flag .result-flag-overlay {
			opacity: 0.22;
		}

		.result-top {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 16px;
		}

		.result-info {
			display: flex;
			flex-direction: column;
			gap: 6px;
			min-width: 0;
		}

		.result-label {
			font-size: 0.74rem;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: var(--muted);
		}

		.result-ip {
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', monospace;
			font-size: 1.08rem;
			font-weight: 700;
			word-break: break-word;
		}

		.copy-target {
			align-self: flex-start;
			margin: 0;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--text);
			text-align: left;
			cursor: pointer;
			transition: color 0.18s ease, text-shadow 0.18s ease;
		}

		.copy-target:hover,
		.copy-target:focus-visible {
			color: #8be9ff;
			text-shadow: 0 0 18px rgba(97, 219, 255, 0.28);
		}

		.copy-target:focus-visible {
			outline: 2px solid rgba(97, 219, 255, 0.48);
			outline-offset: 4px;
			border-radius: 6px;
		}

		.result-detail {
			color: var(--muted);
			font-size: 0.94rem;
			line-height: 1.75;
		}

		.result-detail.is-compact {
			font-size: 0.88rem;
		}

		.status-badge {
			position: relative;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-width: 78px;
			padding: 10px 14px;
			border-radius: 999px;
			border: 1px solid rgba(255, 255, 255, 0.1);
			background: rgba(255, 255, 255, 0.04);
			font-size: 0.82rem;
			font-weight: 700;
			color: #eef8ff;
			white-space: nowrap;
		}

		.status-badge[data-tooltip]::before,
		.status-badge[data-tooltip]::after {
			position: absolute;
			right: 0;
			opacity: 0;
			pointer-events: none;
			transform: translateY(-4px);
			transition: opacity 0.18s ease, transform 0.18s ease;
			z-index: 20;
		}

		.status-badge[data-tooltip] {
			cursor: help;
		}

		.status-badge[data-tooltip]::before {
			content: '';
			top: calc(100% + 6px);
			width: 10px;
			height: 10px;
			margin-right: 18px;
			background: rgba(5, 18, 32, 0.96);
			border-left: 1px solid rgba(255, 255, 255, 0.12);
			border-top: 1px solid rgba(255, 255, 255, 0.12);
			transform: translateY(-4px) rotate(45deg);
		}

		.status-badge[data-tooltip]::after {
			content: attr(data-tooltip);
			top: calc(100% + 10px);
			width: max-content;
			max-width: min(320px, calc(100vw - 44px));
			padding: 10px 12px;
			border-radius: 14px;
			border: 1px solid rgba(255, 255, 255, 0.12);
			background: rgba(5, 18, 32, 0.96);
			box-shadow: 0 16px 36px rgba(0, 0, 0, 0.28);
			color: #edf7ff;
			font-size: 0.78rem;
			font-weight: 600;
			line-height: 1.55;
			text-align: left;
			white-space: normal;
		}

		.status-badge[data-tooltip]:hover::before,
		.status-badge[data-tooltip]:hover::after,
		.status-badge[data-tooltip]:focus-visible::before,
		.status-badge[data-tooltip]:focus-visible::after {
			opacity: 1;
		}

		.status-badge[data-tooltip]:hover::before,
		.status-badge[data-tooltip]:focus-visible::before {
			transform: translateY(0) rotate(45deg);
		}

		.status-badge[data-tooltip]:hover::after,
		.status-badge[data-tooltip]:focus-visible::after {
			transform: translateY(0);
		}

		.status-success {
			background: rgba(52, 211, 153, 0.12);
			border-color: rgba(52, 211, 153, 0.24);
			color: #a5f3cf;
		}

		.status-error {
			background: rgba(251, 113, 133, 0.12);
			border-color: rgba(251, 113, 133, 0.24);
			color: #fecdd7;
		}

		.status-pending {
			background: rgba(251, 191, 36, 0.12);
			border-color: rgba(251, 191, 36, 0.22);
			color: #fde68a;
		}

		.result-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-top: 14px;
		}

		.meta-chip {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-radius: 999px;
			background: rgba(97, 219, 255, 0.07);
			border: 1px solid rgba(97, 219, 255, 0.12);
			color: var(--text-soft);
			font-size: 0.82rem;
		}

		.meta-chip svg {
			width: 14px;
			height: 14px;
			flex: none;
			opacity: 0.92;
		}

		.meta-chip-strong {
			background: rgba(97, 219, 255, 0.12);
			border-color: rgba(97, 219, 255, 0.22);
			color: #dff9ff;
		}

		.meta-chip-danger {
			background: rgba(251, 113, 133, 0.1);
			border-color: rgba(251, 113, 133, 0.22);
			color: #ffd1d8;
		}

		.exit-list {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-top: 14px;
			align-items: center;
		}

		.exit-list-label {
			color: var(--muted);
			font-size: 0.84rem;
		}

		.exit-ip-card {
			position: relative;
			display: inline-flex;
			align-items: center;
			gap: 10px;
			padding: 8px 12px 8px 14px;
			border: 1px solid rgba(52, 211, 153, 0.22);
			border-radius: 999px;
			background: linear-gradient(135deg, rgba(52, 211, 153, 0.14), rgba(97, 219, 255, 0.08));
			color: var(--text);
			font-weight: 700;
			cursor: default;
			transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
		}

		.exit-ip-card:hover {
			transform: translateY(-1px);
			border-color: rgba(97, 219, 255, 0.32);
			background: linear-gradient(135deg, rgba(52, 211, 153, 0.18), rgba(97, 219, 255, 0.12));
		}

		.exit-ip-card.is-active {
			border-color: rgba(97, 219, 255, 0.52);
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.26), rgba(52, 211, 153, 0.16));
			box-shadow: inset 0 0 0 1px rgba(97, 219, 255, 0.14), 0 0 0 1px rgba(97, 219, 255, 0.1);
		}

		.exit-ip-card.is-copied {
			border-color: rgba(97, 219, 255, 0.6);
			background: linear-gradient(135deg, rgba(97, 219, 255, 0.22), rgba(52, 211, 153, 0.14));
		}

		.exit-ip-copy {
			border: 0;
			background: transparent;
			padding: 0;
			margin: 0;
			color: var(--text);
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', monospace;
			font-size: 1.05rem;
			font-weight: 700;
			word-break: break-word;
			text-align: left;
			cursor: pointer;
			transition: color 0.18s ease, text-shadow 0.18s ease;
		}

		.exit-ip-copy:hover,
		.exit-ip-copy:focus-visible {
			color: #8be9ff;
			text-shadow: 0 0 18px rgba(97, 219, 255, 0.28);
		}

		.exit-ip-copy:focus-visible {
			outline: 2px solid rgba(97, 219, 255, 0.48);
			outline-offset: 3px;
			border-radius: 6px;
		}

		.exit-ip-card.is-copied .exit-ip-copy {
			color: #8be9ff;
		}

		.exit-ip-detail-toggle {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex: 0 0 auto;
			width: 22px;
			height: 22px;
			border: 0;
			border-radius: 50%;
			padding: 0;
			margin: 0;
			background: rgba(255, 255, 255, 0.06);
			color: var(--muted);
			cursor: pointer;
			transition: color 0.18s ease, background 0.18s ease;
		}

		.exit-ip-detail-toggle svg {
			display: block;
			width: 13px;
			height: 13px;
			transition: transform 0.22s ease;
		}

		.exit-ip-detail-toggle:hover,
		.exit-ip-detail-toggle:focus-visible {
			color: #8be9ff;
			background: rgba(97, 219, 255, 0.16);
		}

		.exit-ip-detail-toggle:focus-visible {
			outline: 2px solid rgba(97, 219, 255, 0.48);
			outline-offset: 3px;
		}

		.exit-ip-card.is-active .exit-ip-detail-toggle {
			color: #8be9ff;
			background: rgba(97, 219, 255, 0.18);
		}

		.exit-ip-card.is-active .exit-ip-detail-toggle svg {
			transform: rotate(180deg);
		}

		.map-container-wrapper {
			display: none;
			margin-top: 16px;
			height: 330px;
			border-radius: 22px;
			overflow: hidden;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(255, 255, 255, 0.03);
		}

		#map-template {
			display: none;
		}

		#global-map {
			width: 100%;
			height: 100%;
			background: #09111d;
		}

		#global-map .leaflet-tile-pane {
			filter: invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.96) saturate(0.88);
		}

		.map-popup {
			font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
			font-size: 0.88rem;
			line-height: 1.65;
			color: #10253d;
		}

		.map-popup b {
			color: #081826;
		}

		.leaflet-control-zoom {
			display: none !important;
		}

		.leaflet-control-attribution {
			display: block !important;
			margin: 0 !important;
			padding: 4px 8px !important;
			border-radius: 12px 0 0 0;
			background: rgba(9, 17, 29, 0.78) !important;
			backdrop-filter: blur(10px);
			box-shadow: 0 10px 24px rgba(3, 7, 18, 0.22);
			color: rgba(223, 240, 255, 0.84) !important;
			font-size: 11px;
			line-height: 1.4;
		}

		.leaflet-control-attribution a {
			color: inherit !important;
		}

		.site-footer {
			padding-top: 22px;
			font-size: 0.9rem;
		}

		.site-footer a,
		#visit-count {
			color: #bff4ff;
			font-family: 'Space Grotesk', 'Plus Jakarta Sans', sans-serif;
			font-weight: 600;
			letter-spacing: -0.02em;
			font-variant-numeric: tabular-nums;
		}

		.site-footer a {
			text-decoration: none;
			border-bottom: 1px solid rgba(191, 244, 255, 0.28);
		}

		.site-footer a:hover {
			color: #ffffff;
			border-bottom-color: rgba(255, 255, 255, 0.42);
		}

		html[data-theme='light'] .brand-chip {
			border-color: rgba(86, 124, 158, 0.18);
			background: rgba(255, 255, 255, 0.76);
			color: #1d5d83;
		}

		html[data-theme='light'] .brand-title {
			color: #10253d;
		}

		html[data-theme='light'] .theme-toggle {
			background: transparent;
			border-color: transparent;
			box-shadow: none;
		}

		html[data-theme='light'] .surface-card {
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.72)),
				var(--panel);
		}

		html[data-theme='light'] .section-kicker,
		html[data-theme='light'] .guide-card-label {
			color: #0f7ab8;
		}

		html[data-theme='light'] .section-kicker::before,
		html[data-theme='light'] .guide-card-label::before {
			background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.72));
		}

		html[data-theme='light'] .panel-badge,
		html[data-theme='light'] .guide-badge {
			background: rgba(14, 165, 233, 0.08);
			border-color: rgba(14, 165, 233, 0.16);
			color: #0f5f8e;
		}

		html[data-theme='light'] .summary-backend-badge.state-ready {
			background: rgba(16, 185, 129, 0.12);
			border-color: rgba(5, 150, 105, 0.22);
			color: #0f766e;
		}

		html[data-theme='light'] .summary-backend-badge.state-error {
			background: rgba(239, 68, 68, 0.1);
			border-color: rgba(220, 38, 38, 0.18);
			color: #b91c1c;
		}

		html[data-theme='light'] .field-label {
			color: #17324a;
		}

		html[data-theme='light'] .input-control {
			background: rgba(255, 255, 255, 0.82);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
		}

		html[data-theme='light'] .input-control::placeholder {
			color: #7b8fa3;
		}

		html[data-theme='light'] .input-control:focus {
			background: #ffffff;
			border-color: rgba(14, 165, 233, 0.3);
			box-shadow: 0 0 0 4px rgba(14, 165, 233, 0.1);
		}

		html[data-theme='light'] .history-toggle {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.78);
			color: #5b738b;
		}

		html[data-theme='light'] .history-toggle:hover {
			color: #10253d;
			background: rgba(14, 165, 233, 0.1);
		}

		html[data-theme='light'] .history-dropdown {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.96);
			box-shadow: 0 20px 36px rgba(43, 67, 91, 0.16);
		}

		html[data-theme='light'] .history-item:hover {
			background: rgba(14, 165, 233, 0.08);
			color: #10253d;
		}

		html[data-theme='light'] .history-item.is-empty {
			color: #7f92a6;
		}

		html[data-theme='light'] .mode-card,
		html[data-theme='light'] .progress-container,
		html[data-theme='light'] .metric-card,
		html[data-theme='light'] .results-empty,
		html[data-theme='light'] .guide-flow,
		html[data-theme='light'] .guide-step,
		html[data-theme='light'] .map-container-wrapper {
			background: rgba(255, 255, 255, 0.62);
			border-color: rgba(95, 123, 150, 0.14);
		}

		html[data-theme='light'] .slider {
			background: rgba(14, 165, 233, 0.12);
			border-color: rgba(95, 123, 150, 0.14);
		}

		html[data-theme='light'] .slider::before {
			background: #ffffff;
			box-shadow: 0 6px 14px rgba(43, 67, 91, 0.18);
		}

		html[data-theme='light'] .primary-btn {
			box-shadow: 0 18px 34px rgba(14, 165, 233, 0.18);
		}

		html[data-theme='light'] .primary-btn:hover {
			box-shadow: 0 22px 40px rgba(14, 165, 233, 0.22);
		}

		html[data-theme='light'] .primary-btn.is-stop {
			box-shadow: 0 18px 34px rgba(225, 29, 72, 0.18);
		}

		html[data-theme='light'] .primary-btn.is-stop:hover {
			box-shadow: 0 22px 40px rgba(225, 29, 72, 0.24);
		}

		html[data-theme='light'] .results-pill {
			border-color: rgba(95, 123, 150, 0.16);
			background: rgba(255, 255, 255, 0.72);
			color: #16324a;
		}

		html[data-theme='light'] .results-pill.state-idle {
			color: #365168;
		}

		html[data-theme='light'] .results-pill.state-resolving {
			background: rgba(245, 158, 11, 0.12);
			border-color: rgba(245, 158, 11, 0.18);
			color: #9a6706;
		}

		html[data-theme='light'] .results-pill.state-running {
			background: rgba(14, 165, 233, 0.12);
			border-color: rgba(14, 165, 233, 0.18);
			color: #0f5f8e;
		}

		html[data-theme='light'] .results-pill.state-done {
			background: rgba(5, 150, 105, 0.12);
			border-color: rgba(5, 150, 105, 0.18);
			color: #047857;
		}

		html[data-theme='light'] .results-pill.state-empty,
		html[data-theme='light'] .results-pill.state-error,
		html[data-theme='light'] .results-pill.state-stopped {
			background: rgba(225, 29, 72, 0.1);
			border-color: rgba(225, 29, 72, 0.16);
			color: #be123c;
		}

		html[data-theme='light'] .filter-chip {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.66);
			color: #365168;
		}

		html[data-theme='light'] .filter-toggle {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.66);
			color: #23415a;
		}

		html[data-theme='light'] .filter-toggle:hover {
			border-color: rgba(14, 165, 233, 0.24);
			background: rgba(14, 165, 233, 0.08);
			color: #10253d;
		}

		html[data-theme='light'] .filter-chip:hover {
			border-color: rgba(14, 165, 233, 0.24);
			background: rgba(14, 165, 233, 0.08);
			color: #10253d;
		}

		html[data-theme='light'] .filter-chip.is-active {
			border-color: rgba(14, 165, 233, 0.32);
			background: linear-gradient(135deg, rgba(14, 165, 233, 0.16), rgba(5, 150, 105, 0.1));
			color: #0f5f8e;
			box-shadow: inset 0 0 0 1px rgba(14, 165, 233, 0.08);
		}

		html[data-theme='light'] .export-chip {
			border-color: rgba(245, 158, 11, 0.22);
			background: linear-gradient(135deg, rgba(245, 158, 11, 0.14), rgba(251, 191, 36, 0.12));
			color: #9a6706;
		}

		html[data-theme='light'] .export-chip:hover {
			border-color: rgba(245, 158, 11, 0.34);
			background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(251, 191, 36, 0.16));
			color: #7c4a03;
		}

		html[data-theme='light'] .filter-chip:disabled,
		html[data-theme='light'] .filter-chip.is-disabled {
			border-color: rgba(95, 123, 150, 0.1);
			background: rgba(255, 255, 255, 0.36);
			color: rgba(91, 115, 139, 0.46);
			box-shadow: none;
		}

		html[data-theme='light'] .export-toast {
			border-color: rgba(14, 165, 233, 0.2);
			background: rgba(255, 255, 255, 0.94);
			box-shadow: 0 18px 44px rgba(15, 23, 42, 0.16);
			color: #075985;
		}

		html[data-theme='light'] .export-toast.is-error {
			border-color: rgba(225, 29, 72, 0.2);
			color: #be123c;
		}

		html[data-theme='light'] .filter-empty {
			border-color: rgba(95, 123, 150, 0.16);
			background: rgba(255, 255, 255, 0.58);
			color: #5b738b;
		}

		html[data-theme='light'] .empty-visual {
			background:
				radial-gradient(circle at 30% 30%, rgba(14, 165, 233, 0.18), transparent 42%),
				linear-gradient(160deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.4));
			border-color: rgba(95, 123, 150, 0.14);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
		}

		html[data-theme='light'] .empty-visual span:nth-child(1) {
			background: rgba(14, 165, 233, 0.18);
		}

		html[data-theme='light'] .empty-visual span:nth-child(2) {
			background: rgba(20, 184, 166, 0.28);
		}

		html[data-theme='light'] .empty-visual span:nth-child(3) {
			background: rgba(16, 37, 61, 0.12);
		}

		html[data-theme='light'] .guide-shell::before {
			background:
				radial-gradient(circle at top right, rgba(14, 165, 233, 0.1), transparent 30%),
				radial-gradient(circle at bottom left, rgba(20, 184, 166, 0.08), transparent 28%);
		}

		html[data-theme='light'] .guide-card {
			border-color: rgba(95, 123, 150, 0.14);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(255, 255, 255, 0.56)),
				rgba(255, 255, 255, 0.74);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
		}

		html[data-theme='light'] .guide-card-accent {
			background:
				radial-gradient(circle at top left, rgba(14, 165, 233, 0.12), transparent 38%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.56)),
				rgba(255, 255, 255, 0.78);
		}

		html[data-theme='light'] .guide-card-warm {
			background:
				radial-gradient(circle at top right, rgba(245, 158, 11, 0.12), transparent 34%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.56)),
				rgba(255, 255, 255, 0.78);
		}

		html[data-theme='light'] .guide-card a,
		html[data-theme='light'] .site-footer a,
		html[data-theme='light'] #visit-count {
			color: #0f7ab8;
			border-bottom-color: rgba(14, 165, 233, 0.24);
		}

		html[data-theme='light'] .guide-card a:hover,
		html[data-theme='light'] .site-footer a:hover {
			color: #10253d;
			border-bottom-color: rgba(16, 37, 61, 0.2);
		}

		html[data-theme='light'] .guide-quote {
			border-color: rgba(245, 158, 11, 0.16);
			background: rgba(245, 158, 11, 0.08);
			color: #9a6706;
		}

		html[data-theme='light'] .guide-step.is-source strong {
			color: #0284c7;
		}

		html[data-theme='light'] .guide-step.is-proxy strong {
			color: #0f766e;
		}

		html[data-theme='light'] .guide-step.is-target strong {
			color: #b45309;
		}

		html[data-theme='light'] .guide-arrow {
			color: rgba(14, 165, 233, 0.56);
		}

		html[data-theme='light'] .guide-tip {
			border-color: rgba(14, 165, 233, 0.14);
			background:
				linear-gradient(90deg, rgba(14, 165, 233, 0.08), rgba(20, 184, 166, 0.06), rgba(245, 158, 11, 0.06)),
				rgba(255, 255, 255, 0.62);
			color: #365168;
		}

		html[data-theme='light'] .guide-tip strong {
			color: #10253d;
		}

		html[data-theme='light'] .proxy-search-shell::before {
			background:
				radial-gradient(circle at top right, rgba(245, 158, 11, 0.1), transparent 30%),
				radial-gradient(circle at bottom left, rgba(14, 165, 233, 0.1), transparent 28%);
		}

		html[data-theme='light'] select.proxy-search-control {
			background-image:
				linear-gradient(45deg, transparent 50%, currentColor 50%),
				linear-gradient(135deg, currentColor 50%, transparent 50%);
			background-position:
				calc(100% - 23px) 50%,
				calc(100% - 17px) 50%;
			background-size: 6px 6px, 6px 6px;
			background-repeat: no-repeat;
		}

		html[data-theme='light'] .result-item {
			border-color: rgba(95, 123, 150, 0.14);
			background:
				linear-gradient(180deg, rgba(255, 255, 255, 0.88), transparent 38%),
				var(--panel-strong);
		}

		html[data-theme='light'] .result-item::before {
			background: rgba(121, 140, 159, 0.38);
		}

		html[data-theme='light'] .status-badge {
			border-color: rgba(95, 123, 150, 0.14);
			background: rgba(255, 255, 255, 0.72);
			color: #16324a;
		}

		html[data-theme='light'] .status-badge[data-tooltip]::before,
		html[data-theme='light'] .status-badge[data-tooltip]::after {
			background: rgba(16, 37, 61, 0.96);
			border-color: rgba(255, 255, 255, 0.18);
			color: #f7fbff;
		}

		html[data-theme='light'] .status-success {
			background: rgba(5, 150, 105, 0.12);
			border-color: rgba(5, 150, 105, 0.16);
			color: #047857;
		}

		html[data-theme='light'] .status-error {
			background: rgba(225, 29, 72, 0.1);
			border-color: rgba(225, 29, 72, 0.16);
			color: #be123c;
		}

		html[data-theme='light'] .status-pending {
			background: rgba(245, 158, 11, 0.12);
			border-color: rgba(245, 158, 11, 0.16);
			color: #9a6706;
		}

		html[data-theme='light'] .meta-chip {
			background: rgba(14, 165, 233, 0.08);
			border-color: rgba(14, 165, 233, 0.12);
			color: #23415a;
		}

		html[data-theme='light'] .meta-chip-strong {
			background: rgba(14, 165, 233, 0.12);
			border-color: rgba(14, 165, 233, 0.18);
			color: #075985;
		}

		html[data-theme='light'] .meta-chip-danger {
			background: rgba(225, 29, 72, 0.08);
			border-color: rgba(225, 29, 72, 0.14);
			color: #be123c;
		}

		html[data-theme='light'] .exit-ip-card {
			border-color: rgba(5, 150, 105, 0.18);
			background: linear-gradient(135deg, rgba(5, 150, 105, 0.08), rgba(14, 165, 233, 0.08));
			color: #17324a;
		}

		html[data-theme='light'] .exit-ip-card:hover {
			border-color: rgba(14, 165, 233, 0.24);
			background: linear-gradient(135deg, rgba(5, 150, 105, 0.12), rgba(14, 165, 233, 0.12));
		}

		html[data-theme='light'] .exit-ip-card.is-active {
			border-color: rgba(14, 165, 233, 0.32);
			background: linear-gradient(135deg, rgba(14, 165, 233, 0.18), rgba(5, 150, 105, 0.12));
			box-shadow: inset 0 0 0 1px rgba(14, 165, 233, 0.1), 0 0 0 1px rgba(14, 165, 233, 0.08);
		}

		html[data-theme='light'] .exit-ip-copy {
			color: #17324a;
		}

		html[data-theme='light'] .exit-ip-copy:hover,
		html[data-theme='light'] .exit-ip-copy:focus-visible {
			color: #0b7fb5;
		}

		html[data-theme='light'] .exit-ip-card.is-copied .exit-ip-copy {
			color: #0b7fb5;
		}

		html[data-theme='light'] .exit-ip-detail-toggle {
			background: rgba(23, 50, 74, 0.06);
			color: rgba(23, 50, 74, 0.62);
		}

		html[data-theme='light'] .exit-ip-detail-toggle:hover,
		html[data-theme='light'] .exit-ip-detail-toggle:focus-visible {
			color: #0b7fb5;
			background: rgba(14, 165, 233, 0.14);
		}

		html[data-theme='light'] .exit-ip-card.is-active .exit-ip-detail-toggle {
			color: #0b7fb5;
			background: rgba(14, 165, 233, 0.16);
		}

		html[data-theme='light'] #global-map {
			background: #dfeaf3;
		}

		html[data-theme='light'] #global-map .leaflet-tile-pane {
			filter: none;
		}

		html[data-theme='light'] .leaflet-control-attribution {
			background: rgba(255, 255, 255, 0.92) !important;
			box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
			color: rgba(15, 23, 42, 0.72) !important;
		}

		@media (max-width: 980px) {
			.workspace-grid {
				grid-template-columns: 1fr;
			}

			.header-note {
				text-align: left;
				max-width: none;
			}

			.guide-grid {
				grid-template-columns: 1fr;
			}

		}

		@media (max-width: 720px) {
			.page-shell {
				padding: 22px 14px 32px;
			}

			.header-note {
				flex: none;
			}

			.results-list:not(:empty) {
				margin-top: 18px;
			}

			.site-header,
			.panel-header,
			.results-header,
			.guide-header,
			.proxy-search-header,
			.control-row,
			.results-empty,
			.result-top {
				flex-direction: column;
			}

			.site-header,
			.panel-header,
			.results-header,
			.guide-header,
			.proxy-search-header,
			.control-row {
				align-items: stretch;
			}

			.control-panel,
			.side-card,
			.results-shell,
			.guide-shell,
			.proxy-search-shell {
				padding: 22px;
			}

			.mode-card {
				min-width: 0;
			}

			.progress-head {
				flex-direction: column;
				align-items: flex-start;
			}

			.summary-top {
				flex-direction: column;
				align-items: stretch;
			}

			.summary-backend {
				flex-direction: column;
				align-items: stretch;
				max-width: none;
				width: 100%;
			}

			.summary-backend-badge {
				width: 100%;
				justify-content: flex-start;
			}

			.guide-flow {
				grid-template-columns: 1fr;
				padding: 20px;
			}

			.guide-arrow {
				display: none;
			}
		}

		@media (max-width: 560px) {
			.meta-chip {
				width: 100%;
				justify-content: center;
			}

			.exit-ip-card {
				width: 100%;
				justify-content: space-between;
			}

			.exit-ip-copy {
				text-align: left;
			}

			.filter-row-label,
			.filter-options {
				width: 100%;
			}

			.filter-chip {
				flex: 1 1 128px;
			}

			.results-empty {
				grid-template-columns: 1fr;
				text-align: center;
			}

			.empty-visual {
				margin: 0 auto;
			}

			.summary-grid {
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 10px;
			}

			.metric-card {
				padding: 14px;
			}

			.proxy-search-btn {
				flex-basis: 100%;
			}
		}
	</style>
</head>
<body>
	<div class="page-shell">
		<div class="ambient ambient-one"></div>
		<div class="ambient ambient-two"></div>

		<header class="site-header">
			<div class="brand">
				<div class="brand-title">Check ProxyIP</div>
				<div class="brand-chip">
					<span class="brand-chip-text">
						<span class="brand-dot"></span>
						<span>Cloudflare Workers Toolkit</span>
					</span>
					<button class="theme-toggle" type="button" id="themeToggle" aria-label="切换日间和夜间模式" title="切换日间和夜间模式">
						<span class="theme-toggle-switch" aria-hidden="true">
							<svg class="theme-toggle-icon theme-toggle-icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="4"></circle>
								<path d="M12 2v2"></path>
								<path d="M12 20v2"></path>
								<path d="m4.93 4.93 1.41 1.41"></path>
								<path d="m17.66 17.66 1.41 1.41"></path>
								<path d="M2 12h2"></path>
								<path d="M20 12h2"></path>
								<path d="m6.34 17.66-1.41 1.41"></path>
								<path d="m19.07 4.93-1.41 1.41"></path>
							</svg>
							<span class="theme-toggle-thumb"></span>
							<svg class="theme-toggle-icon theme-toggle-icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"></path>
							</svg>
						</span>
					</button>
				</div>
			</div>
			<div class="header-note">基于 Cloudflare 的 ProxyIP 检测工具，支持单个或批量目标解析、可用性验证与出口信息查看。</div>
		</header>

		<main class="site-main">
			<section class="workspace-grid">
				<div class="surface-card control-panel">
					<div class="panel-header">
						<div>
							<p class="section-kicker">Workspace</p>
							<h2 class="panel-title">开始检测</h2>
							<p class="panel-copy">输入单个 IP、IPv6、域名或一整段列表。单条模式支持历史记录，批量模式适合直接粘贴多行目标。</p>
						</div>
						<div class="panel-badge">实时解析与验证</div>
					</div>

					<div class="input-zone">
						<label class="field-label" for="inputList">ProxyIP / 域名目标</label>
						<div class="input-wrapper" id="inputContainer">
							<input class="input-control" type="text" id="inputList" placeholder="例如：ProxyIP.CMLiussss.net 或 8.223.63.150:443">
							<button class="history-toggle" type="button" id="historyBtn" aria-label="查看历史记录">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<circle cx="12" cy="12" r="10"></circle>
									<polyline points="12 6 12 12 16 14"></polyline>
								</svg>
							</button>
							<div class="history-dropdown" id="historyDropdown"></div>
						</div>
						<p class="field-hint" id="fieldHint">单条模式支持历史快速回填，按 Enter 可以直接开始检测。</p>
					</div>

					<div class="control-row">
						<div class="mode-card">
							<div class="mode-copy">
								<strong>批量检测</strong>
								<div class="mode-state" id="modeLabel">Single / 单目标</div>
							</div>
							<label class="switch">
								<input type="checkbox" id="batchMode">
								<span class="slider"></span>
							</label>
						</div>

						<button class="primary-btn" id="checkBtn" type="button">
							<span>开始检测</span>
							<small>Resolve + Check</small>
						</button>
					</div>

				</div>

				<aside class="side-column">
					<div class="surface-card side-card summary-card" id="summaryCard">
						<div class="summary-flag-overlay" id="summaryFlagOverlay" aria-hidden="true"></div>
						<div class="summary-top">
							<div class="summary-copy">
								<p class="section-kicker">Summary</p>
								<h3 class="summary-title" id="summaryHeadline">等待输入</h3>
								<p class="summary-description" id="summaryDescription">实时统计和检测概览。</p>
							</div>
							<div class="summary-backend">
								<span class="panel-badge summary-backend-badge state-loading" id="summaryBackendBadge">验证服务定位中...</span>
							</div>
						</div>
						<div id="progressContainer" class="progress-container">
							<div class="progress-head">
								<span>检测进度</span>
								<span id="progressText">尚未开始</span>
							</div>
							<div class="progress-track">
								<div id="progressBar" class="progress-bar"></div>
							</div>
						</div>
						<div class="summary-grid">
							<div class="metric-card">
								<span>目标数</span>
								<strong id="statTotal">0</strong>
							</div>
							<div class="metric-card">
								<span>有效</span>
								<strong id="statSuccess">0</strong>
							</div>
							<div class="metric-card">
								<span>待完成</span>
								<strong id="statPending">0</strong>
							</div>
							<div class="metric-card">
								<span>失败</span>
								<strong id="statFailed">0</strong>
							</div>
						</div>
					</div>
				</aside>
			</section>

			<section class="surface-card results-shell">
				<div class="results-header">
					<div>
						<p class="section-kicker">Results</p>
						<h2 class="results-title">检测结果</h2>
						<p class="results-subtitle" id="resultMeta">结果、落地 IP 和地图会在这里按检测进度逐步展开。</p>
					</div>
					<div class="results-pill state-idle" id="resultPill">Idle</div>
				</div>

				<div class="results-empty" id="resultsEmpty">
					<div class="empty-visual" aria-hidden="true">
						<span></span>
						<span></span>
						<span></span>
					</div>
					<div class="empty-copy">
						<h3 id="emptyStateTitle">等待开始检测</h3>
						<p id="emptyStateDescription">输入目标后，检测结果、出口信息和地图会在这里展示。</p>
					</div>
				</div>

				<div class="results-filters" id="resultsFilters" hidden>
					<button class="filter-toggle" id="filterToggle" type="button" aria-expanded="false">
						<span id="filterToggleText">筛选：全部结果</span>
						<span class="filter-toggle-icon" aria-hidden="true">
							<svg viewBox="0 0 12 12" fill="none">
								<path d="M2.5 4.25L6 7.75L9.5 4.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
							</svg>
						</span>
					</button>
					<div class="filter-panel" id="filterPanel" hidden>
						<div class="filter-row">
							<span class="filter-row-label">筛选</span>
							<div class="filter-options" id="primaryFilterGroup" aria-label="结果类型筛选"></div>
						</div>
						<div class="filter-row">
							<span class="filter-row-label">地区</span>
							<div class="filter-options" id="countryFilterGroup" aria-label="出口地区筛选"></div>
						</div>
						<div class="filter-row">
							<span class="filter-row-label">导出</span>
							<div class="filter-options export-options" id="exportGroup" aria-label="导出当前筛选结果">
								<button class="filter-chip export-chip" type="button" data-export-format="clipboard">粘贴板</button>
								<button class="filter-chip export-chip" type="button" data-export-format="txt">TXT文件</button>
								<button class="filter-chip export-chip" type="button" data-export-format="csv">CSV文件</button>
							</div>
						</div>
					</div>
				</div>
				<div class="filter-empty" id="filterEmpty" hidden>当前筛选没有匹配的检测结果。</div>
				<div id="results" class="results-list"></div>
			</section>

			<section class="surface-card guide-shell">
				<div class="guide-header">
					<div>
						<p class="section-kicker">Guide</p>
						<h2 class="results-title">什么是 ProxyIP</h2>
						<p class="results-subtitle">用一段更接近实际部署场景的说明，快速理解 ProxyIP 的定义、作用和筛选标准。</p>
					</div>
					<div class="guide-badge">Cloudflare Workers / TCP</div>
				</div>

				<div class="guide-grid">
					<article class="guide-card guide-card-accent">
						<div class="guide-card-label">概念</div>
						<h3>ProxyIP 是一个可被验证的中转入口</h3>
						<p>在 Cloudflare Workers 的使用语境里，ProxyIP 通常指那些能够成功代理到 Cloudflare 服务的第三方 IP。它不是 Cloudflare 官方分配给你的接入地址，而是一个可以替你完成转发的外部节点。</p>
					</article>

					<article class="guide-card guide-card-warm">
						<div class="guide-card-label">限制来源</div>
						<h3>为什么很多场景会专门去找 ProxyIP</h3>
						<p>Cloudflare Workers 的 <a href="https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/" target="_blank" rel="noreferrer">TCP sockets 文档</a> 明确提到，指向 <a href="https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/" target="_blank" rel="noreferrer">Cloudflare IP ranges</a> 的出站 TCP 连接会被阻止。也就是说，某些依赖直连 Cloudflare IP 的链路，不能在 Workers 里直接打通。</p>
						<div class="guide-quote">Outbound TCP sockets to Cloudflare IP ranges are blocked.</div>
					</article>
				</div>

				<div class="guide-flow">
					<div class="guide-step is-source">
						<strong>Cloudflare Workers</strong>
						<span>发起请求，尝试访问目标服务</span>
					</div>
					<div class="guide-arrow" aria-hidden="true">→</div>
					<div class="guide-step is-proxy">
						<strong>ProxyIP 节点</strong>
						<span>位于第三方网络，负责中转和反向代理</span>
					</div>
					<div class="guide-arrow" aria-hidden="true">→</div>
					<div class="guide-step is-target">
						<strong>Cloudflare 服务</strong>
						<span>最终被访问的站点、边缘服务或 CDN 目标</span>
					</div>
					<p class="guide-flow-caption">实际作用可以理解为：让 Workers 先连到第三方节点，再由该节点替你把流量送到 Cloudflare 侧，绕开直连 Cloudflare IP 的限制。</p>
				</div>

				<div class="guide-grid guide-grid-secondary">
					<article class="guide-card">
						<div class="guide-card-label">应用场景</div>
						<h3>为什么像 edgetunnel、epeius 这类项目会用到它</h3>
						<p>当目标网站本身走的是 Cloudflare CDN 或 Cloudflare 边缘网络时，项目如果需要直接建立到目标地址的 TCP 连接，就可能因为上述限制而失败。配置可用的 ProxyIP 后，这类项目就能借助中转节点继续完成访问。</p>
					</article>

					<article class="guide-card">
						<div class="guide-card-label">有效特征</div>
						<h3>有效的 ProxyIP，通常至少满足这些条件</h3>
						<ul class="guide-list">
							<li>能够成功建立代理到指定端口（通常为 443）的 TCP 连接</li>
							<li>具备反向代理 Cloudflare IP 段的 HTTPS 服务能力</li>
						</ul>
					</article>
				</div>

				<div class="guide-tip">
					<strong>这页检测的意义：</strong>本工具不是只做静态解析，而是尽量模拟真实链路去验证目标是否真的可用，帮助你更快筛掉“看起来在线、实际不可做代理”的候选 IP。
				</div>
			</section>

			<section class="surface-card proxy-search-shell" aria-labelledby="proxySearchTitle">
				<div class="proxy-search-header">
					<div>
						<p class="section-kicker">Finder</p>
						<h2 class="results-title" id="proxySearchTitle">获取更多 ProxyIP</h2>
						<p class="results-subtitle">按端口和地区从网络测绘数据库中发现候选 ProxyIP，方便继续放回本工具检测可用性。</p>
					</div>
					<div class="guide-badge">More</div>
				</div>

				<div class="proxy-search-form">
					<label class="proxy-search-field" for="proxyRegionSelect">
						<span class="field-label">地区:</span>
						<select class="input-control proxy-search-control" id="proxyRegionSelect">
							<option value="custom">✍️ 自定义地区</option>
							<optgroup label="🌏 亚洲 / AS">
								<option value="HK">🇭🇰 香港</option>
								<option value="TW">🇨🇳 台湾</option>
								<option value="KR">🇰🇷 韩国</option>
								<option value="JP">🇯🇵 日本</option>
								<option value="SG">🇸🇬 新加坡</option>
								<option value="IN">🇮🇳 印度</option>
							</optgroup>
							<optgroup label="🌎 北美 / NA">
								<option value="US">🇺🇸 美国</option>
								<option value="CA">🇨🇦 加拿大</option>
							</optgroup>
							<optgroup label="🌍 欧洲 / EU">
								<option value="GB">🇬🇧 英国</option>
								<option value="DE">🇩🇪 德国</option>
								<option value="FR">🇫🇷 法国</option>
							</optgroup>
							<optgroup label="🌏 大洋洲 / OC">
								<option value="AU">🇦🇺 澳大利亚</option>
							</optgroup>
						</select>
					</label>

					<label class="proxy-search-field proxy-search-custom-field" for="customRegionInput" id="customRegionField">
						<span class="field-label">国家代码:</span>
						<input class="input-control proxy-search-control proxy-search-input" type="text" id="customRegionInput" maxlength="2" pattern="[A-Za-z]{2}" placeholder="US" autocomplete="off" inputmode="text">
					</label>

					<label class="proxy-search-field" for="proxyPortSelect">
						<span class="field-label">端口:</span>
						<select class="input-control proxy-search-control" id="proxyPortSelect">
							<option value="443">443</option>
							<option value="nonstandard">非标</option>
						</select>
					</label>
					<button class="primary-btn proxy-search-btn" id="fofaBtn" type="button">FOFA</button>
				</div>
			</section>
		</main>

		<footer class="site-footer">
			<div>${备案内容}</div>
		</footer>
	</div>

	<div id="map-template">
		<div id="global-map"></div>
	</div>

	<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
	<script>
		// 接口基地址：用于 /check 与 /cdn-cgi/trace，未配置 API_HOST 时默认同源（含 scheme 与端口）。
		const API_BASE = '${apiBase}';
		const checkBtn = document.getElementById('checkBtn');
		let inputList = document.getElementById('inputList');
		const inputContainer = document.getElementById('inputContainer');
		const batchMode = document.getElementById('batchMode');
		const resultsDiv = document.getElementById('results');
		const progressBar = document.getElementById('progressBar');
		const progressText = document.getElementById('progressText');
		const globalMap = document.getElementById('global-map');
		const historyBtn = document.getElementById('historyBtn');
		const historyDropdown = document.getElementById('historyDropdown');
		const fieldHint = document.getElementById('fieldHint');
		const modeLabel = document.getElementById('modeLabel');
		const summaryCard = document.getElementById('summaryCard');
		const summaryFlagOverlay = document.getElementById('summaryFlagOverlay');
		const summaryHeadline = document.getElementById('summaryHeadline');
		const summaryDescription = document.getElementById('summaryDescription');
		const summaryBackendBadge = document.getElementById('summaryBackendBadge');
		const statTotal = document.getElementById('statTotal');
		const statSuccess = document.getElementById('statSuccess');
		const statPending = document.getElementById('statPending');
		const statFailed = document.getElementById('statFailed');
		const resultMeta = document.getElementById('resultMeta');
		const resultPill = document.getElementById('resultPill');
		const resultsEmpty = document.getElementById('resultsEmpty');
		const emptyStateTitle = document.getElementById('emptyStateTitle');
		const emptyStateDescription = document.getElementById('emptyStateDescription');
		const resultsFilters = document.getElementById('resultsFilters');
		const filterToggle = document.getElementById('filterToggle');
		const filterPanel = document.getElementById('filterPanel');
		const filterToggleText = document.getElementById('filterToggleText');
		const primaryFilterGroup = document.getElementById('primaryFilterGroup');
		const countryFilterGroup = document.getElementById('countryFilterGroup');
		const exportGroup = document.getElementById('exportGroup');
		const filterEmpty = document.getElementById('filterEmpty');
		const themeToggle = document.getElementById('themeToggle');
		const proxyRegionSelect = document.getElementById('proxyRegionSelect');
		const proxyPortSelect = document.getElementById('proxyPortSelect');
		const customRegionField = document.getElementById('customRegionField');
		const customRegionInput = document.getElementById('customRegionInput');
		const fofaBtn = document.getElementById('fofaBtn');
		const THEME_STORAGE_KEY = 'cf_proxy_theme';
		const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
		const BASE_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
		const BASE_MAP_TILE_OPTIONS = {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a> contributors'
		};

		let map = null;
		let mapLayers = [];
		let mapSvgRenderer = null;
		let cfLocationIndex = new Map();
		let cfLocationsPromise = null;
		let backendServicePromise = null;
		let mapRenderToken = 0;
		let totalTargets = 0;
		let completedCount = 0;
		let successCount = 0;
		let inputCount = 0;
		let appState = 'idle';
		let activeRun = null;
		const CHECK_CONCURRENCY = 32;
		const RESOLVE_BATCH_SIZE = 15;
		const RESOLVE_BATCH_TIMEOUT_MS = 3000;
		const RESOLVE_BATCH_MAX_ATTEMPTS = 3;
		const PRIMARY_RESULT_FILTERS = [
			{ key: 'all', label: '全部' },
			{ key: 'success', label: '有效' },
			{ key: 'failed', label: '失败' },
			{ key: 'only_ipv4', label: 'OnlyIPv4' },
			{ key: 'only_ipv6', label: 'OnlyIPv6' },
			{ key: 'dual_stack', label: 'IPv4&IPv6' }
		];
		const EXPORT_CSV_COLUMNS = [
			{ header: 'IP', path: 'proxyIP' },
			{ header: 'PORT', path: 'portRemote' },
			{ header: 'IPV4_CONNECT_MS', path: 'probe_results.ipv4.connect_ms' },
			{ header: 'IPV4_EXIT_IP', path: 'probe_results.ipv4.exit.ip' },
			{ header: 'IPV4_EXIT_COLO', path: 'probe_results.ipv4.exit.colo' },
			{ header: 'IPV4_EXIT_ASN', path: 'probe_results.ipv4.exit.asn' },
			{ header: 'IPV4_EXIT_ORG', path: 'probe_results.ipv4.exit.asOrganization' },
			{ header: 'IPV4_EXIT_CONTINENT', path: 'probe_results.ipv4.exit.continent' },
			{ header: 'IPV4_EXIT_COUNTRY', path: 'probe_results.ipv4.exit.country' },
			{ header: 'IPV4_EXIT_REGION', path: 'probe_results.ipv4.exit.region' },
			{ header: 'IPV4_EXIT_CITY', path: 'probe_results.ipv4.exit.city' },
			{ header: 'IPV4_EXIT_LONGITUDE', path: 'probe_results.ipv4.exit.longitude' },
			{ header: 'IPV4_EXIT_LATITUDE', path: 'probe_results.ipv4.exit.latitude' },
			{ header: 'IPV6_CONNECT_MS', path: 'probe_results.ipv6.connect_ms' },
			{ header: 'IPV6_EXIT_IP', path: 'probe_results.ipv6.exit.ip' },
			{ header: 'IPV6_EXIT_COLO', path: 'probe_results.ipv6.exit.colo' },
			{ header: 'IPV6_EXIT_ASN', path: 'probe_results.ipv6.exit.asn' },
			{ header: 'IPV6_EXIT_ORG', path: 'probe_results.ipv6.exit.asOrganization' },
			{ header: 'IPV6_EXIT_CONTINENT', path: 'probe_results.ipv6.exit.continent' },
			{ header: 'IPV6_EXIT_COUNTRY', path: 'probe_results.ipv6.exit.country' },
			{ header: 'IPV6_EXIT_REGION', path: 'probe_results.ipv6.exit.region' },
			{ header: 'IPV6_EXIT_CITY', path: 'probe_results.ipv6.exit.city' },
			{ header: 'IPV6_EXIT_LONGITUDE', path: 'probe_results.ipv6.exit.longitude' },
			{ header: 'IPV6_EXIT_LATITUDE', path: 'probe_results.ipv6.exit.latitude' }
		];
		let resultRecords = [];
		let activePrimaryFilter = 'all';
		let activeCountryFilter = 'all';
		let isFilterPanelExpanded = false;
		let isCreatingResultBatch = false;
		let exportToastTimer = null;

		function getStoredTheme() {
			try {
				const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
				return storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : '';
			} catch {
				return '';
			}
		}

		function getSystemTheme() {
			return systemThemeQuery.matches ? 'dark' : 'light';
		}

		function applyTheme(theme, source) {
			const nextTheme = theme === 'light' ? 'light' : 'dark';
			const isDark = nextTheme === 'dark';

			document.documentElement.dataset.theme = nextTheme;
			document.documentElement.style.colorScheme = nextTheme;

			if (!themeToggle) return;

			themeToggle.setAttribute('aria-pressed', String(isDark));
			themeToggle.setAttribute(
				'aria-label',
				isDark
					? '当前为夜间模式，点击切换到日间模式。'
					: '当前为日间模式，点击切换到夜间模式。'
			);
			themeToggle.title = source === 'stored'
				? (isDark ? '夜间模式，已保存到本地' : '日间模式，已保存到本地')
				: (isDark ? '夜间模式，当前跟随系统' : '日间模式，当前跟随系统');
		}

		function initializeTheme() {
			const storedTheme = getStoredTheme();
			applyTheme(storedTheme || getSystemTheme(), storedTheme ? 'stored' : 'system');
		}

		initializeTheme();

		function initMap() {
			if (map) return;
			map = L.map('global-map', {
				zoomControl: false,
				attributionControl: true
			}).setView([20, 0], 2);
			map.attributionControl.setPrefix(false);
			// OpenStreetMap provides broader global coverage than AMap for international checks.
			L.tileLayer(BASE_MAP_TILE_URL, BASE_MAP_TILE_OPTIONS).addTo(map);
			mapSvgRenderer = L.svg();
			mapSvgRenderer.addTo(map);
		}

		function normalizeColoCode(value) {
			const code = String(value || '').trim().toUpperCase();
			return /^[A-Z0-9]{3,4}$/.test(code) ? code : '';
		}

		function isValidCoordinatePair(value) {
			return Array.isArray(value)
				&& value.length === 2
				&& value.every(function (entry) { return Number.isFinite(entry); })
				&& Math.abs(value[0]) <= 90
				&& Math.abs(value[1]) <= 180;
		}

		function parseCoordinatePair(value) {
			if (typeof value === 'string') {
				const parts = value.split(',').map(function (entry) {
					return Number(entry.trim());
				});
				return isValidCoordinatePair(parts) ? parts : null;
			}

			if (Array.isArray(value)) {
				const parts = value.map(function (entry) {
					return Number(entry);
				});
				return isValidCoordinatePair(parts) ? parts : null;
			}

			return null;
		}

		async function loadCfLocations() {
			if (cfLocationsPromise) {
				return cfLocationsPromise;
			}

			cfLocationsPromise = fetch('/locations')
				.then(function (response) {
					if (!response.ok) {
						throw new Error('Failed to load /locations: ' + response.status);
					}
					return response.json();
				})
				.then(function (payload) {
					const nextIndex = new Map();
					if (Array.isArray(payload)) {
						payload.forEach(function (entry) {
							const code = normalizeColoCode(entry?.iata);
							const lat = Number(entry?.lat);
							const lon = Number(entry?.lon);
							if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) {
								return;
							}
							nextIndex.set(code, {
								code: code,
								lat: lat,
								lon: lon,
								city: String(entry?.city || '').trim(),
								region: String(entry?.region || '').trim(),
								country: String(entry?.cca2 || '').trim()
							});
						});
					}
					cfLocationIndex = nextIndex;
					return nextIndex;
				})
				.catch(function (error) {
					console.error('Failed to preload Cloudflare locations', error);
					return cfLocationIndex;
				});

			return cfLocationsPromise;
		}

		function getCfLocation(coloCode) {
			const normalizedCode = normalizeColoCode(coloCode);
			if (!normalizedCode) {
				return null;
			}

			const location = cfLocationIndex.get(normalizedCode);
			return location ? {
				code: location.code,
				lat: location.lat,
				lon: location.lon,
				city: location.city,
				region: location.region,
				country: location.country
			} : null;
		}

		function setSummaryBackendStatus(text, state, titleText) {
			if (!summaryBackendBadge) return;
			summaryBackendBadge.innerText = text;
			summaryBackendBadge.className = 'panel-badge summary-backend-badge state-' + (state || 'loading');
			if (titleText) {
				summaryBackendBadge.title = titleText;
			} else {
				summaryBackendBadge.removeAttribute('title');
			}
		}

		function updateSummaryBackendFlag(flagUrl) {
			if (!summaryCard || !summaryFlagOverlay) return;

			if (flagUrl) {
				summaryCard.classList.add('has-backend-flag');
				summaryFlagOverlay.style.backgroundImage = 'url("' + flagUrl + '")';
				return;
			}

			summaryCard.classList.remove('has-backend-flag');
			summaryFlagOverlay.style.backgroundImage = '';
		}

		async function loadBackendServiceInfo() {
			if (backendServicePromise) {
				return backendServicePromise;
			}

			setSummaryBackendStatus('验证服务定位中...', 'loading');

			backendServicePromise = Promise.all([
				loadCfLocations(),
				fetchTextWithTimeout(API_BASE + '/cdn-cgi/trace', { cache: 'no-store' }, 8000)
			]).then(function (results) {
				const traceResult = results[1];
				const payload = parseTracePayload(traceResult?.payload);

				if (!traceResult?.response?.ok) {
					throw new Error('Failed to load backend trace: ' + traceResult?.response?.status);
				}

				const coloCode = normalizeColoCode(payload?.colo);
				const cfLocation = getCfLocation(coloCode);
				const countryCode = String(cfLocation?.country || '').trim().toUpperCase();
				const city = String(cfLocation?.city || '').trim();
				const locationLabel = [countryCode, city].filter(Boolean).join(' · ');
				const titleText = '当前实际由 Cloudflare '
					+ (coloCode || '未知')
					+ ' 机房'
					+ (locationLabel ? '（' + locationLabel + '）' : '')
					+ ' 的验证后端发起连通性测试。若被测试对象距离该测试后端过远，可能因网络延迟过高或连接超时而误报为不可用，这并不一定代表该目标在你的实际使用环境中同样不可用。';

				setSummaryBackendStatus(countryCode + ' · ' + coloCode + ' 服务已就绪', 'ready', titleText);
				updateSummaryBackendFlag(getFlagUrlFromCountryCode(countryCode));

				return {
					colo: coloCode,
					countryCode: countryCode,
					city: city,
					host: String(payload?.h || '').trim(),
					ip: String(payload?.ip || '').trim()
				};
			}).catch(function (error) {
				console.error('Failed to load backend service info', error);
				setSummaryBackendStatus('验证服务定位失败', 'error', error?.message || '');
				updateSummaryBackendFlag('');
				return null;
			});

			return backendServicePromise;
		}

		function clearMapLayers() {
			mapLayers.forEach(function (layer) {
				map.removeLayer(layer);
			});
			mapLayers = [];
		}

		function buildCfLocationLabel(cfLocation) {
			return [cfLocation?.city, cfLocation?.region, cfLocation?.country].filter(Boolean).join(', ');
		}

		function ensureRouteArrowMarkerDef() {
			const overlaySvg = map?.getPanes?.().overlayPane?.querySelector('svg');
			if (!overlaySvg) {
				return '';
			}

			const svgNamespace = 'http://www.w3.org/2000/svg';
			let defs = overlaySvg.querySelector('defs');
			if (!defs) {
				defs = document.createElementNS(svgNamespace, 'defs');
				overlaySvg.insertBefore(defs, overlaySvg.firstChild);
			}

			const markerId = 'route-flow-arrowhead';
			if (!overlaySvg.querySelector('#' + markerId)) {
				const marker = document.createElementNS(svgNamespace, 'marker');
				marker.setAttribute('id', markerId);
				marker.setAttribute('viewBox', '0 0 10 10');
				marker.setAttribute('refX', '8');
				marker.setAttribute('refY', '5');
				marker.setAttribute('markerWidth', '7');
				marker.setAttribute('markerHeight', '7');
				marker.setAttribute('orient', 'auto');
				marker.setAttribute('markerUnits', 'strokeWidth');

				const arrowPath = document.createElementNS(svgNamespace, 'path');
				arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
				arrowPath.setAttribute('fill', '#8be9ff');
				arrowPath.setAttribute('fill-opacity', '0.95');

				marker.appendChild(arrowPath);
				defs.appendChild(marker);
			}

			return markerId;
		}

		function applyArrowStyleToPolyline(polyline) {
			const markerId = ensureRouteArrowMarkerDef();
			const pathElement = polyline?.getElement?.();
			if (!markerId || !pathElement) {
				return;
			}

			pathElement.setAttribute('marker-end', 'url(#' + markerId + ')');
			pathElement.setAttribute('stroke-linecap', 'round');
		}

		function createExitPopup(exitData) {
			const locationText = formatExitLocation(exitData) || 'Location unknown';
			const networkText = formatExitNetwork(exitData) || 'Network unknown';
			const coloCode = normalizeColoCode(exitData?.colo);
			const coloText = coloCode ? '<br>CF Colo: ' + escapeHtml(coloCode) : '';
			return '<div class="map-popup"><b>Exit IP</b><br>'
				+ escapeHtml(exitData?.ip || 'Unknown')
				+ '<br>' + escapeHtml(locationText)
				+ '<br>' + escapeHtml(networkText)
				+ coloText
				+ '</div>';
		}

		function createCfPopup(cfLocation) {
			const locationText = buildCfLocationLabel(cfLocation) || 'Location unknown';
			return '<div class="map-popup"><b>Cloudflare Colo</b><br>'
				+ escapeHtml(cfLocation?.code || 'Unknown')
				+ '<br>' + escapeHtml(locationText)
				+ '</div>';
		}

		function escapeHtml(value) {
			return String(value ?? '').replace(/[&<>"']/g, function (char) {
				return {
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;'
				}[char];
			});
		}

		function getMetaChipIcon(iconName) {
			const icons = {
				prep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path></svg>',
				location: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z"></path><circle cx="12" cy="11" r="2.5"></circle></svg>',
				network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="2"></rect><rect x="3" y="14" width="18" height="6" rx="2"></rect><circle cx="7" cy="7" r="1"></circle><circle cx="7" cy="17" r="1"></circle><path d="M12 10v4"></path></svg>',
				exits: '<svg viewBox="0 0 44 43" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M30.251 8.73438C30.251 6.13691 32.4057 4.03125 35.0635 4.03125C37.7214 4.03125 39.876 6.13691 39.876 8.73438C39.876 10.8649 38.4264 12.6646 36.4385 13.2427V15.4531C36.4385 19.1638 33.3605 22.1719 29.5635 22.1719H15.8135C13.5354 22.1719 11.6885 23.9767 11.6885 26.2031V29.7573C13.6764 30.3354 15.126 32.1351 15.126 34.2656C15.126 36.8631 12.9714 38.9688 10.3135 38.9688C7.65566 38.9688 5.50101 36.8631 5.50101 34.2656C5.50101 32.1351 6.95063 30.3354 8.93853 29.7573V13.2427C6.95063 12.6646 5.50101 10.8649 5.50101 8.73438C5.50101 6.13691 7.65566 4.03125 10.3135 4.03125C12.9714 4.03125 15.126 6.13691 15.126 8.73438C15.126 10.8649 13.6764 12.6646 11.6885 13.2427V20.8277C12.8376 19.9842 14.2658 19.4844 15.8135 19.4844H29.5635C31.8417 19.4844 33.6885 17.6795 33.6885 15.4531V13.2427C31.7006 12.6646 30.251 10.8649 30.251 8.73438Z" fill="currentColor"></path></svg>',
				error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path></svg>',
				info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10v5"></path><circle cx="12" cy="7" r="1"></circle></svg>',
				retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 5v6h-6"></path><path d="M4 19v-6h6"></path><path d="M7 17a7 7 0 0 0 11-4"></path><path d="M17 7A7 7 0 0 0 6 11"></path></svg>'
			};
			return icons[iconName] || icons.info;
		}

		function buildMetaChip(text, iconName, modifierClass) {
			const className = modifierClass ? 'meta-chip ' + modifierClass : 'meta-chip';
			return '<span class="' + className + '">' + getMetaChipIcon(iconName) + '<span>' + escapeHtml(text) + '</span></span>';
		}

		function buildCopyableTarget(target) {
			const value = String(target || '');
			return '<button class="result-ip copy-target" type="button" data-copy-target="' + escapeHtml(value) + '" title="点击复制候选目标" aria-label="复制候选目标 ' + escapeHtml(value) + '">' + escapeHtml(value) + '</button>';
		}

		function normalizeBatchInputValue(value) {
			const targets = [];
			normalizeDelimitedTargetText(value).split('\\n').forEach(function (line) {
				extractTargetsFromInputLine(line).forEach(function (target) {
					targets.push(target);
				});
			});
			return targets.join('\\n');
		}

		function normalizeBatchEditingValue(value) {
			return normalizeDelimitedTargetText(value);
		}

		function stripTargetLabel(value) {
			const normalized = normalizeDelimitedTargetText(value);
			const firstLine = normalized.split('\\n')[0] || '';
			const targets = extractTargetsFromInputLine(firstLine);
			return targets[0] || stripInlineComment(firstLine);
		}

		function normalizeDelimitedTargetText(value) {
			return String(value ?? '')
				.replace(/\\r\\n?/g, '\\n')
				.replace(/[\uFF0C]/g, ',')
				.replace(/([^\\s,\\t|]+)[,\\t ]+\\s*(\\d{1,5})(?=\\s*(?:$|\\n|#|\\/\\/))/g, function (match, host, port) {
					return isValidPortValue(port) ? host + ':' + normalizePortValue(port) : match;
				})
				.replace(/,/g, '\\n')
				.replace(/\\t+/g, ' ');
		}

		function stripInlineComment(value) {
			const text = String(value || '').split('#')[0];
			for (let i = 0; i < text.length - 1; i++) {
				if (text[i] === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
					return text.slice(0, i).trim();
				}
			}
			return text.trim();
		}

		function isValidPortValue(value) {
			const text = String(value || '').trim();
			if (!/^\\d{1,5}$/.test(text)) return false;
			const port = Number(text);
			return Number.isInteger(port) && port >= 1 && port <= 65535;
		}

		function normalizePortValue(value) {
			return String(Number(String(value || '').trim()));
		}

		function trimTargetToken(value) {
			return String(value || '')
				.trim()
				.replace(/^[<({'"“‘]+/, '')
				.replace(/[>)\\}'"”’。，、；;]+$/g, '');
		}

		function extractTargetsFromInputLine(value) {
			const line = stripInlineComment(String(value || '').replace(/\uFF1A/g, ':'));
			const matches = [];

			collectUrlTargetMatches(line, matches);
			collectBracketedIPv6TargetMatches(line, matches);
			collectDottedTargetMatches(line, matches);
			collectRawIPv6TargetMatches(line, matches);

			return matches
				.sort(function (left, right) { return left.index - right.index; })
				.map(function (match) { return match.target; });
		}

		function collectUrlTargetMatches(line, matches) {
			const pattern = /(?:https?|wss?|tcp|tls|socks5?):\\/\\/[^\\s'"<>|]+/ig;
			let match;
			while ((match = pattern.exec(line)) !== null) {
				addTargetMatch(line, matches, match.index, match.index + match[0].length, match[0]);
			}
		}

		function collectBracketedIPv6TargetMatches(line, matches) {
			const pattern = /\\[[0-9a-fA-F:.]+\\](?::\\d{1,5})?/g;
			let match;
			while ((match = pattern.exec(line)) !== null) {
				addTargetMatch(line, matches, match.index, match.index + match[0].length, match[0]);
			}
		}

		function collectDottedTargetMatches(line, matches) {
			const pattern = /[A-Za-z0-9.-]+(?::\\d{1,5})?/g;
			let match;
			while ((match = pattern.exec(line)) !== null) {
				addTargetMatch(line, matches, match.index, match.index + match[0].length, match[0]);
			}
		}

		function collectRawIPv6TargetMatches(line, matches) {
			const pattern = /[^\\s|,，;；]+/g;
			let match;
			while ((match = pattern.exec(line)) !== null) {
				const token = trimTargetToken(match[0]);
				const colonMatches = token.match(/:/g) || [];
				if (colonMatches.length < 2 || !isClientRawIPv6(token)) continue;

				const offset = match[0].indexOf(token);
				const index = match.index + Math.max(offset, 0);
				addTargetMatch(line, matches, index, index + token.length, token);
			}
		}

		function addTargetMatch(line, matches, index, end, rawTarget) {
			if (hasTargetRangeOverlap(matches, index, end)) return;

			const target = normalizeExtractedTarget(rawTarget);
			if (!target) return;

			matches.push({ index, end, target });
		}

		function hasTargetRangeOverlap(matches, index, end) {
			return matches.some(function (match) {
				return index < match.end && end > match.index;
			});
		}

		function normalizeExtractedTarget(value) {
			const token = trimTargetToken(value);
			if (!token) return '';

			if (/^(?:https?|wss?|tcp|tls|socks5?):\\/\\//i.test(token)) {
				try {
					const url = new URL(token);
					return formatExtractedHostPort(url.hostname, url.port);
				} catch {
					return '';
				}
			}

			if (token.startsWith('[')) {
				const endBracketIndex = token.indexOf(']');
				if (endBracketIndex === -1) return '';

				const host = token.slice(1, endBracketIndex);
				const rest = token.slice(endBracketIndex + 1);
				if (!rest) return formatExtractedHostPort(host, '');
				if (!rest.startsWith(':')) return '';

				const port = rest.slice(1);
				return isValidPortValue(port) ? formatExtractedHostPort(host, port) : '';
			}

			const colonMatches = token.match(/:/g) || [];
			if (colonMatches.length === 1) {
				const separatorIndex = token.lastIndexOf(':');
				const maybePort = token.slice(separatorIndex + 1);
				if (!isValidPortValue(maybePort)) return '';
				return formatExtractedHostPort(token.slice(0, separatorIndex), maybePort);
			}

			return formatExtractedHostPort(token, '');
		}

		function formatExtractedHostPort(hostValue, portValue) {
			let host = trimTargetToken(hostValue).replace(/^\\[|\\]$/g, '');
			if (!host) return '';

			if (isPrivateClientIPv4(host)) return '';
			if (!isIPv4LikeTarget(host) && !isClientRawIPv6(host) && !isClientDomain(host)) return '';

			const port = isValidPortValue(portValue) ? normalizePortValue(portValue) : '';
			if (portValue && !port) return '';

			if (isClientRawIPv6(host)) {
				return '[' + host + ']' + (port ? ':' + port : '');
			}

			return host + (port ? ':' + port : '');
		}

		function isIPv4LikeTarget(value) {
			return /^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(String(value || ''));
		}

		function isPrivateClientIPv4(value) {
			if (!isClientIPv4(value)) return false;

			const parts = String(value || '').split('.').map(function (part) { return Number(part); });
			return parts[0] === 10
				|| parts[0] === 127
				|| parts[0] === 0
				|| (parts[0] === 169 && parts[1] === 254)
				|| (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
				|| (parts[0] === 192 && parts[1] === 168);
		}

		function isClientDomain(value) {
			const labels = String(value || '').split('.');
			return labels.length >= 2
				&& /[A-Za-z]/.test(labels[labels.length - 1])
				&& labels.every(function (label) {
					return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label);
				});
		}

		function parseClientTarget(input) {
			let host = stripTargetLabel(input);
			let port = 443;

			if (host.startsWith('[')) {
				const ipv6PortIndex = host.lastIndexOf(']:');
				if (ipv6PortIndex !== -1) {
					const maybePort = Number(host.slice(ipv6PortIndex + 2));
					if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
						port = maybePort;
						host = host.slice(0, ipv6PortIndex + 1);
					}
				}
				return { host, port };
			}

			const colonMatches = host.match(/:/g) || [];
			if (colonMatches.length === 1) {
				const separatorIndex = host.lastIndexOf(':');
				const maybePort = Number(host.slice(separatorIndex + 1));
				if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
					port = maybePort;
					host = host.slice(0, separatorIndex);
				}
			}

			return { host, port };
		}

		function isClientIPv4(value) {
			const parts = String(value || '').split('.');
			return parts.length === 4 && parts.every(function (part) {
				if (!/^\\d{1,3}$/.test(part)) return false;
				const num = Number(part);
				return num >= 0 && num <= 255;
			});
		}

		function isClientRawIPv6(value) {
			const text = String(value || '');
			const colonMatches = text.match(/:/g) || [];
			return colonMatches.length >= 2 && /^[0-9a-fA-F:]+$/.test(text);
		}

		function getDirectIpTarget(input) {
			const parsed = parseClientTarget(input);
			const bracketedIPv6 = parsed.host.startsWith('[') && parsed.host.endsWith(']');
			const bracketedIPv6Body = bracketedIPv6 ? parsed.host.slice(1, -1) : '';
			const rawIPv6 = isClientRawIPv6(parsed.host);

			if (isClientIPv4(parsed.host)) {
				return parsed.host + ':' + parsed.port;
			}

			if (rawIPv6) {
				return '[' + parsed.host + ']:' + parsed.port;
			}

			if (bracketedIPv6 && isClientRawIPv6(bracketedIPv6Body)) {
				return parsed.host + ':' + parsed.port;
			}

			return '';
		}

		function pushResolvedTargets(targetGroups, output) {
			const seenTargets = new Set();
			targetGroups.forEach(function (group) {
				group.forEach(function (target) {
					if (seenTargets.has(target)) return;
					seenTargets.add(target);
					output.push(target);
				});
			});
		}

		function uniqueTargets(targets) {
			const seenTargets = new Set();
			return targets.filter(function (target) {
				if (seenTargets.has(target)) return false;
				seenTargets.add(target);
				return true;
			});
		}

		function makeAbortError(message) {
			const error = new Error(message || '检测已停止');
			error.name = 'AbortError';
			return error;
		}

		function isRunStopped(run) {
			return !run || run.cancelled || run.controller.signal.aborted || activeRun !== run;
		}

		function throwIfRunStopped(run) {
			if (isRunStopped(run)) throw makeAbortError();
		}

		function setCheckButtonRunning(isRunning) {
			const label = checkBtn.querySelector('span');
			const hint = checkBtn.querySelector('small');
			checkBtn.disabled = false;
			checkBtn.classList.toggle('is-stop', isRunning);
			if (label) label.innerText = isRunning ? '停止检测' : '开始检测';
			if (hint) hint.innerText = isRunning ? 'Stop' : 'Resolve + Check';
		}

		function stopActiveRun() {
			if (!activeRun || isRunStopped(activeRun)) return;
			activeRun.cancelled = true;
			activeRun.controller.abort();
			progressText.innerText = '正在停止检测...';
			setAppState('stopped');
		}

		function splitIntoChunks(items, size) {
			const chunks = [];
			for (let i = 0; i < items.length; i += size) {
				chunks.push(items.slice(i, i + size));
			}
			return chunks;
		}

		async function fetchJsonWithTimeout(resource, options, timeoutMs, signal) {
			const controller = new AbortController();
			const timer = window.setTimeout(function () {
				controller.abort();
			}, timeoutMs);
			const abortFromSignal = function () {
				controller.abort();
			};
			if (signal) {
				if (signal.aborted) controller.abort();
				else signal.addEventListener('abort', abortFromSignal, { once: true });
			}

			try {
				const response = await fetch(resource, Object.assign({}, options || {}, {
					signal: controller.signal
				}));
				let payload = null;
				try {
					payload = await response.json();
				} catch (error) {
					if (response.ok) {
						throw error;
					}
				}
				return { response, payload };
			} finally {
				window.clearTimeout(timer);
				if (signal) signal.removeEventListener('abort', abortFromSignal);
			}
		}

		async function fetchTextWithTimeout(resource, options, timeoutMs, signal) {
			const controller = new AbortController();
			const timer = window.setTimeout(function () {
				controller.abort();
			}, timeoutMs);
			const abortFromSignal = function () {
				controller.abort();
			};
			if (signal) {
				if (signal.aborted) controller.abort();
				else signal.addEventListener('abort', abortFromSignal, { once: true });
			}

			try {
				const response = await fetch(resource, Object.assign({}, options || {}, {
					signal: controller.signal
				}));
				const payload = await response.text();
				return { response, payload };
			} finally {
				window.clearTimeout(timer);
				if (signal) signal.removeEventListener('abort', abortFromSignal);
			}
		}

		function parseTracePayload(text) {
			const payload = {};
			const lines = String(text || '').replace(/\\r/g, '').split('\\n');

			lines.forEach(function (line) {
				const separatorIndex = line.indexOf('=');
				if (separatorIndex <= 0) {
					return;
				}

				const key = line.slice(0, separatorIndex).trim();
				const value = line.slice(separatorIndex + 1).trim();
				if (key) {
					payload[key] = value;
				}
			});

			return payload;
		}

		function updateResolveBatchProgress(batchIndex, totalBatches, attempt) {
			const retryText = attempt > 1
				? '，第 ' + attempt + ' 次尝试'
				: '';
			progressText.innerText = '正在解析目标... 第 ' + batchIndex + ' / ' + totalBatches + ' 批' + retryText;
		}

		function applyResolveBatchPayload(batch, payload) {
			const results = payload && Array.isArray(payload.results) ? payload.results : null;
			if (!results) {
				throw new Error('Invalid resolve batch response');
			}

			results.forEach(function (result, index) {
				const job = batch[index];
				if (!job) return;

				if (result && Array.isArray(result.targets)) {
					job.group.push(...result.targets);
				}

				if (result && result.error) {
					console.warn('Resolve skipped for', job.line, result.error);
				}
			});
		}

		async function requestResolveBatch(batch, run) {
			throwIfRunStopped(run);
			const payload = {
				targets: batch.map(function (job) { return job.line; })
			};
			const result = await fetchJsonWithTimeout('/resolve-batch', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			}, RESOLVE_BATCH_TIMEOUT_MS, run?.controller.signal);

			if (!result.response.ok) {
				const errorMessage = result.payload && result.payload.error
					? result.payload.error
					: 'Resolve batch failed with status ' + result.response.status;
				throw new Error(errorMessage);
			}

			applyResolveBatchPayload(batch, result.payload);
		}

		async function resolveBatchWithRetry(batch, batchIndex, totalBatches, run) {
			for (let attempt = 1; attempt <= RESOLVE_BATCH_MAX_ATTEMPTS; attempt++) {
				throwIfRunStopped(run);
				updateResolveBatchProgress(batchIndex, totalBatches, attempt);

				try {
					await requestResolveBatch(batch, run);
					return true;
				} catch (error) {
					if (isRunStopped(run)) throw error;
					const label = error && error.name === 'AbortError'
						? 'Resolve batch timeout'
						: 'Resolve batch error';

					if (attempt >= RESOLVE_BATCH_MAX_ATTEMPTS) {
						console.error(label + ', abandoned batch', batch.map(function (job) { return job.line; }), error);
						return false;
					}

					console.warn(label + ', retrying batch', batch.map(function (job) { return job.line; }), error);
				}
			}

			return false;
		}

		async function resolveBatchJobs(resolveJobs, run) {
			const batches = splitIntoChunks(resolveJobs, RESOLVE_BATCH_SIZE);
			let failedBatchCount = 0;

			for (let index = 0; index < batches.length; index++) {
				throwIfRunStopped(run);
				const resolved = await resolveBatchWithRetry(batches[index], index + 1, batches.length, run);
				if (!resolved) {
					failedBatchCount++;
				}
			}

			if (failedBatchCount > 0) {
				console.warn('Resolve batches abandoned:', failedBatchCount);
			}
		}

		async function resolveSingleJob(job, run) {
			for (let attempt = 1; attempt <= RESOLVE_BATCH_MAX_ATTEMPTS; attempt++) {
				throwIfRunStopped(run);
				try {
					const result = await fetchJsonWithTimeout('/resolve?proxyip=' + encodeURIComponent(job.line), {}, RESOLVE_BATCH_TIMEOUT_MS, run?.controller.signal);
					if (!result.response.ok) {
						console.error('Resolve error for', job.line, result.payload || result.response.status);
						return false;
					}

					if (Array.isArray(result.payload)) {
						job.group.push(...result.payload);
					}
					return true;
				} catch (error) {
					if (isRunStopped(run)) throw error;
					if (attempt >= RESOLVE_BATCH_MAX_ATTEMPTS) {
						console.error('Resolve timeout for', job.line, error);
						return false;
					}
					console.warn('Resolve timeout for ' + job.line + ', retrying', error);
				}
			}

			return false;
		}

		async function runWithConcurrency(items, limit, worker, run) {
			let nextIndex = 0;
			const workerCount = Math.min(Math.max(Number(limit) || 1, 1), items.length);
			const runners = [];

			async function runNext() {
				while (nextIndex < items.length && !isRunStopped(run)) {
					const currentIndex = nextIndex++;
					await worker(items[currentIndex], currentIndex);
				}
			}

			for (let i = 0; i < workerCount; i++) {
				runners.push(runNext());
			}

			await Promise.all(runners);
		}

		function normalizeBatchInputControl(control) {
			if (!control || control.tagName !== 'TEXTAREA') return;

			const rawValue = control.value;
			const nextValue = normalizeBatchEditingValue(rawValue);

			if (nextValue === rawValue) return;

			const selectionStart = control.selectionStart ?? rawValue.length;
			const selectionEnd = control.selectionEnd ?? rawValue.length;
			const nextSelectionStart = normalizeBatchEditingValue(rawValue.slice(0, selectionStart)).length;
			const nextSelectionEnd = normalizeBatchEditingValue(rawValue.slice(0, selectionEnd)).length;

			control.value = nextValue;
			control.setSelectionRange(nextSelectionStart, nextSelectionEnd);
		}

		function bindInputShortcut() {
			inputList.addEventListener('input', function () {
				if (!batchMode.checked) return;
				normalizeBatchInputControl(inputList);
			});

			inputList.addEventListener('keydown', function (event) {
				const shouldRunSingle = !batchMode.checked && event.key === 'Enter';
				const shouldRunBatch = batchMode.checked && event.key === 'Enter' && (event.ctrlKey || event.metaKey);

				if (shouldRunSingle || shouldRunBatch) {
					event.preventDefault();
					checkBtn.click();
				}
			});
		}

		function setModeVisuals(isBatch) {
			modeLabel.innerText = isBatch ? 'Batch / 多目标' : 'Single / 单目标';
			fieldHint.innerText = isBatch
				? '批量模式下每行一个目标，按 Ctrl + Enter 可以直接开始检测。'
				: '单条模式支持历史快速回填，按 Enter 可以直接开始检测。';
		}

		function showEmptyState(title, description) {
			emptyStateTitle.innerText = title;
			emptyStateDescription.innerText = description;
			resultsEmpty.style.display = 'grid';
		}

		function hideEmptyState() {
			resultsEmpty.style.display = 'none';
		}

		function setAppState(nextState) {
			appState = nextState;
			renderDashboard();
		}

		function renderDashboard() {
			const failCount = Math.max(completedCount - successCount, 0);
			const pendingCount = Math.max(totalTargets - completedCount, 0);

			statTotal.innerText = String(totalTargets);
			statSuccess.innerText = String(successCount);
			statPending.innerText = String(pendingCount);
			statFailed.innerText = String(failCount);

			let headline = '等待输入';
			let description = '当前阶段、实时统计。';
			let meta = '结果、落地 IP 和地图会在这里按检测进度逐步展开。';
			let pillText = 'Idle';

			if (appState === 'resolving') {
				headline = '正在解析目标';
				description = '已接收 ' + inputCount + ' 条输入，正在展开为可检测地址。';
				meta = '解析阶段进行中，准备把输入转换为候选目标。';
				pillText = 'Resolving';
			} else if (appState === 'running') {
				headline = '正在检测 ' + totalTargets + ' 个目标';
				description = '已完成 ' + completedCount + ' 个，当前有效 ' + successCount + ' 个。';
				meta = completedCount + ' / ' + totalTargets + ' 已完成，结果会持续追加。';
				pillText = 'Running';
			} else if (appState === 'done') {
				headline = '检测完成';
				description = '有效 ' + successCount + ' / ' + totalTargets + '，失败 ' + failCount + '。';
				meta = '本轮检测已结束，点击落地 IP 可一键复制，点击右侧箭头查看出口位置和网络信息。';
				pillText = 'Completed';
			} else if (appState === 'empty') {
				headline = '未解析到可检测目标';
				description = '请检查域名、IP 或端口格式后重新尝试。';
				meta = '这次输入没有得到有效候选目标。';
				pillText = 'Empty';
			} else if (appState === 'error') {
				headline = '检测过程中出现错误';
				description = '请求被中断或远端接口异常，可以稍后再试。';
				meta = '运行中断，结果可能不完整。';
				pillText = 'Error';
			} else if (appState === 'stopped') {
				headline = '检测已停止';
				description = '已完成 ' + completedCount + ' / ' + totalTargets + '，有效 ' + successCount + ' 个。';
				meta = '本轮检测已手动停止，未开始的任务不会继续请求。';
				pillText = 'Stopped';
			}

			summaryHeadline.innerText = headline;
			summaryDescription.innerText = description;
			resultMeta.innerText = meta;
			resultPill.innerText = pillText;
			resultPill.className = 'results-pill state-' + appState;
		}

		function updateProgress() {
			const percent = totalTargets > 0 ? Math.round((completedCount / totalTargets) * 100) : 0;
			progressBar.style.width = percent + '%';
			progressText.innerText = completedCount + ' / ' + totalTargets;
			renderDashboard();
		}

		function resetResultFilters() {
			resultRecords = [];
			activePrimaryFilter = 'all';
			activeCountryFilter = 'all';
			isFilterPanelExpanded = false;
			updateResultFilters();
		}

		function createResultRecord(target, itemObj) {
			const record = {
				target: target,
				el: itemObj.el,
				status: 'pending',
				supportsIpv4: false,
				supportsIpv6: false,
				ipv4Countries: [],
				ipv6Countries: [],
				countries: [],
				data: null,
				exitIps: []
			};
			resultRecords.push(record);
			itemObj.record = record;
			if (!isCreatingResultBatch) {
				updateResultFilters();
			}
			return record;
		}

		function getBooleanSupport(data, fieldName, probeName) {
			if (typeof data?.[fieldName] === 'boolean') {
				return data[fieldName] === true;
			}

			return Boolean(data?.probe_results?.[probeName]?.ok && data.probe_results[probeName].exit);
		}

		function normalizeCountryFilterKey(value) {
			const text = String(value || '').trim();
			if (!text) return '';
			return /^[a-z]{2}$/i.test(text) ? text.toUpperCase() : text;
		}

		function getExitCountryFilterKey(exitData) {
			const candidates = [
				exitData?.country,
				exitData?.countryCode,
				exitData?.country_code,
				exitData?.countryIsoCode,
				exitData?.country_iso_code
			];

			for (const candidate of candidates) {
				const normalized = normalizeCountryFilterKey(candidate);
				if (/^[A-Z]{2}$/.test(normalized)) {
					return normalized;
				}
			}

			for (const candidate of candidates) {
				const normalized = normalizeCountryFilterKey(candidate);
				if (normalized) {
					return normalized;
				}
			}

			return '';
		}

		function getCountryFilterKeys(exitIps, stackName) {
			const countries = [];
			exitIps.forEach(function (entry) {
				if (stackName && entry.stack !== stackName) return;
				const country = getExitCountryFilterKey(entry.exitData);
				if (country && !countries.includes(country)) {
					countries.push(country);
				}
			});
			return countries;
		}

		function updateResultRecordAsSuccess(record, data, exitIps) {
			if (!record) return;
			record.status = 'success';
			record.supportsIpv4 = getBooleanSupport(data, 'supports_ipv4', 'ipv4');
			record.supportsIpv6 = getBooleanSupport(data, 'supports_ipv6', 'ipv6');
			record.ipv4Countries = getCountryFilterKeys(exitIps, 'ipv4');
			record.ipv6Countries = getCountryFilterKeys(exitIps, 'ipv6');
			record.countries = getCountryFilterKeys(exitIps);
			record.data = data || null;
			record.exitIps = Array.isArray(exitIps) ? exitIps : [];
		}

		function updateResultRecordAsError(record, data) {
			if (!record) return;
			record.status = 'error';
			record.supportsIpv4 = false;
			record.supportsIpv6 = false;
			record.ipv4Countries = [];
			record.ipv6Countries = [];
			record.countries = [];
			record.data = data || null;
			record.exitIps = [];
		}

		function markPendingResultsStopped() {
			resultRecords.forEach(function (record) {
				if (record.status !== 'pending') return;

				record.status = 'stopped';
				const item = record.el;
				if (!item) return;

				const badge = item.querySelector('.status-badge');
				const info = item.querySelector('.result-info');
				const meta = item.querySelector('.result-meta');
				const exitList = item.querySelector('.exit-list');

				if (badge) {
					badge.className = 'status-badge status-error';
					badge.innerText = '已停止';
				}
				if (info) {
					info.innerHTML =
						'<span class="result-label">候选目标</span>' +
						buildCopyableTarget(record.target) +
						'<span class="result-detail">检测已手动停止，未继续请求该目标。</span>';
				}
				if (meta) meta.innerHTML = buildMetaChip('已停止', 'info');
				if (exitList) exitList.innerHTML = '';
			});
			updateResultFilters();
		}

		function doesRecordMatchPrimaryFilter(record, filterKey) {
			if (filterKey === 'success') {
				return record.status === 'success';
			}
			if (filterKey === 'failed') {
				return record.status === 'error';
			}
			if (filterKey === 'only_ipv4') {
				return record.supportsIpv4 === true && record.supportsIpv6 === false;
			}
			if (filterKey === 'only_ipv6') {
				return record.supportsIpv4 === false && record.supportsIpv6 === true;
			}
			if (filterKey === 'dual_stack') {
				return record.supportsIpv4 === true && record.supportsIpv6 === true;
			}
			return true;
		}

		function getRecordCountryKeys(record, filterKey) {
			if (filterKey === 'only_ipv4') {
				return record.ipv4Countries;
			}
			if (filterKey === 'only_ipv6') {
				return record.ipv6Countries;
			}
			return record.countries;
		}

		function doesRecordMatchCountryFilter(record, countryKey, filterKey) {
			return countryKey === 'all' || getRecordCountryKeys(record, filterKey).includes(countryKey);
		}

		function getPrimaryFilteredRecords(filterKey) {
			return resultRecords.filter(function (record) {
				return doesRecordMatchPrimaryFilter(record, filterKey);
			});
		}

		function getCountryFilterOptions(baseRecords, filterKey) {
			const countryCounts = new Map();
			baseRecords.forEach(function (record) {
				getRecordCountryKeys(record, filterKey).forEach(function (country) {
					countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
				});
			});

			const options = [{ key: 'all', label: '全部', count: baseRecords.length }];
			Array.from(countryCounts.entries())
				.sort(function (left, right) {
					return right[1] - left[1] || left[0].localeCompare(right[0]);
				})
				.forEach(function (entry) {
					options.push({ key: entry[0], label: entry[0], count: entry[1] });
				});
			return options;
		}

		function renderFilterChip(attributeName, key, label, count, isActive, isDisabled) {
			const className = 'filter-chip'
				+ (isActive ? ' is-active' : '')
				+ (isDisabled ? ' is-disabled' : '');
			const disabledAttribute = isDisabled ? ' disabled aria-disabled="true"' : '';
			return '<button type="button" class="' + className + '" data-' + attributeName + '="' + escapeHtml(key) + '" aria-pressed="' + String(isActive) + '"' + disabledAttribute + '>'
				+ escapeHtml(label + '(' + count + ')')
				+ '</button>';
		}

		function applyResultFilters() {
			let visibleCount = 0;
			resultRecords.forEach(function (record) {
				const shouldShow = doesRecordMatchPrimaryFilter(record, activePrimaryFilter)
					&& doesRecordMatchCountryFilter(record, activeCountryFilter, activePrimaryFilter);
				record.el.hidden = !shouldShow;
				if (shouldShow) {
					visibleCount++;
				}
			});
			return visibleCount;
		}

		function getPrimaryFilterLabel(filterKey) {
			const filter = PRIMARY_RESULT_FILTERS.find(function (entry) {
				return entry.key === filterKey;
			});
			return filter ? filter.label : '全部';
		}

		function getFilterToggleLabel(visibleCount) {
			const activeParts = [];
			if (activePrimaryFilter !== 'all') {
				activeParts.push(getPrimaryFilterLabel(activePrimaryFilter));
			}
			if (activeCountryFilter !== 'all') {
				activeParts.push(activeCountryFilter);
			}

			if (!activeParts.length) {
				return '筛选：全部结果';
			}

			return '筛选：' + activeParts.join(' · ') + ' (' + visibleCount + ')';
		}

		function updateFilterPanelState(visibleCount) {
			if (!filterToggle || !filterPanel || !filterToggleText) return;
			filterPanel.hidden = !isFilterPanelExpanded;
			filterToggle.setAttribute('aria-expanded', String(isFilterPanelExpanded));
			filterToggleText.innerText = getFilterToggleLabel(visibleCount);
		}

		function updateResultFilters() {
			if (!resultsFilters || !filterToggle || !filterPanel || !filterToggleText || !primaryFilterGroup || !countryFilterGroup || !filterEmpty) return;

			if (!resultRecords.length) {
				resultsFilters.hidden = true;
				filterPanel.hidden = true;
				filterToggle.setAttribute('aria-expanded', 'false');
				filterToggleText.innerText = '筛选：全部结果';
				filterEmpty.hidden = true;
				return;
			}

			resultsFilters.hidden = false;
			primaryFilterGroup.innerHTML = PRIMARY_RESULT_FILTERS.map(function (filter) {
				const count = getPrimaryFilteredRecords(filter.key).length;
				return renderFilterChip('primary-filter', filter.key, filter.label, count, activePrimaryFilter === filter.key, count === 0);
			}).join('');

			const baseRecords = getPrimaryFilteredRecords(activePrimaryFilter);
			const countryOptions = getCountryFilterOptions(baseRecords, activePrimaryFilter);
			if (activeCountryFilter !== 'all' && !countryOptions.some(function (option) { return option.key === activeCountryFilter; })) {
				activeCountryFilter = 'all';
			}

			countryFilterGroup.innerHTML = countryOptions.map(function (option) {
				return renderFilterChip('country-filter', option.key, option.label, option.count, activeCountryFilter === option.key);
			}).join('');

			const visibleCount = applyResultFilters();
			updateFilterPanelState(visibleCount);
			filterEmpty.hidden = visibleCount !== 0;
		}

		function getCurrentFilteredRecords() {
			return resultRecords.filter(function (record) {
				return doesRecordMatchPrimaryFilter(record, activePrimaryFilter)
					&& doesRecordMatchCountryFilter(record, activeCountryFilter, activePrimaryFilter);
			});
		}

		function getExportableRecords() {
			return getCurrentFilteredRecords().filter(function (record) {
				return record.status === 'success' && Boolean(record.data);
			});
		}

		function normalizeExportValue(value) {
			if (value === undefined || value === null) {
				return '';
			}
			return String(value).trim();
		}

		function getNestedExportValue(source, path) {
			const parts = path.split('.');
			let current = source;
			for (const part of parts) {
				if (current === undefined || current === null || !Object.prototype.hasOwnProperty.call(current, part)) {
					return '';
				}
				current = current[part];
			}
			return normalizeExportValue(current);
		}

		function getProbeForTextExport(data, stackName) {
			const probe = data?.probe_results?.[stackName];
			return probe?.ok && probe.exit ? probe : null;
		}

		function getTextExportProbeCandidates(data) {
			if (activePrimaryFilter === 'only_ipv4') {
				return [getProbeForTextExport(data, 'ipv4'), getProbeForTextExport(data, 'ipv6')].filter(Boolean);
			}
			if (activePrimaryFilter === 'only_ipv6') {
				return [getProbeForTextExport(data, 'ipv6'), getProbeForTextExport(data, 'ipv4')].filter(Boolean);
			}
			return [getProbeForTextExport(data, 'ipv6'), getProbeForTextExport(data, 'ipv4')].filter(Boolean);
		}

		function getPreferredTextExportProbe(data) {
			const candidates = getTextExportProbeCandidates(data);
			if (activeCountryFilter !== 'all') {
				const countryMatchedProbe = candidates.find(function (probe) {
					return getExitCountryFilterKey(probe.exit) === activeCountryFilter;
				});
				if (countryMatchedProbe) {
					return countryMatchedProbe;
				}
			}
			return candidates[0] || null;
		}

		function buildTextExportLine(data) {
			const proxyIP = normalizeExportValue(data?.proxyIP);
			const portRemote = normalizeExportValue(data?.portRemote);
			if (!proxyIP || !portRemote) {
				return '';
			}

			const exitData = getPreferredTextExportProbe(data)?.exit || {};
			const country = normalizeExportValue(exitData.country);
			const city = normalizeExportValue(exitData.city);
			const asn = normalizeExportValue(exitData.asn);
			const asOrganization = normalizeExportValue(exitData.asOrganization);
			const description = [country, city, asn ? 'AS' + asn : '', asOrganization].filter(Boolean).join(' ');
			return proxyIP + ':' + portRemote + '#' + description;
		}

		function buildTextExport(records) {
			return records.map(function (record) {
				return buildTextExportLine(record.data);
			}).filter(Boolean).join('\\n');
		}

		function escapeCsvValue(value) {
			const text = normalizeExportValue(value);
			if (!/[",\\r\\n]/.test(text)) {
				return text;
			}
			return '"' + text.replace(/"/g, '""') + '"';
		}

		function buildCsvExport(records) {
			const headerLine = EXPORT_CSV_COLUMNS.map(function (column) {
				return escapeCsvValue(column.header);
			}).join(',');
			const rows = records.map(function (record) {
				return EXPORT_CSV_COLUMNS.map(function (column) {
					return escapeCsvValue(getNestedExportValue(record.data, column.path));
				}).join(',');
			});
			return [headerLine].concat(rows).join('\\n');
		}

		function padExportDatePart(value) {
			return String(value).padStart(2, '0');
		}

		function formatExportTimestamp(date) {
			const current = date || new Date();
			return current.getFullYear()
				+ '-' + padExportDatePart(current.getMonth() + 1)
				+ '-' + padExportDatePart(current.getDate())
				+ ' ' + padExportDatePart(current.getHours())
				+ padExportDatePart(current.getMinutes())
				+ padExportDatePart(current.getSeconds());
		}

		function getExportFileLabel() {
			const fallbackText = getFilterToggleLabel(getCurrentFilteredRecords().length);
			const rawText = String(filterToggleText?.innerText || fallbackText || '').trim();
			const label = rawText.replace(/^筛选：\\s*/, '').trim() || '全部结果';
			return label.replace(/[\\\\/:*?"<>|]/g, '_').replace(/\\s+/g, ' ').trim() || '全部结果';
		}

		function getExportFileName(extension) {
			return getExportFileLabel() + ' ' + formatExportTimestamp(new Date()) + '.' + extension;
		}

		function downloadTextFile(content, filename, mimeType) {
			const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = filename;
			link.style.display = 'none';
			document.body.appendChild(link);
			link.click();
			link.remove();
			window.setTimeout(function () {
				URL.revokeObjectURL(url);
			}, 1000);
		}

		async function writeTextToClipboard(text) {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
				return;
			}

			const textArea = document.createElement('textarea');
			textArea.value = text;
			textArea.setAttribute('readonly', '');
			textArea.style.position = 'fixed';
			textArea.style.top = '-1000px';
			textArea.style.left = '-1000px';
			document.body.appendChild(textArea);
			textArea.select();
			const didCopy = document.execCommand('copy');
			textArea.remove();
			if (!didCopy) {
				throw new Error('Clipboard copy command failed');
			}
		}

		function showExportToast(message, tone) {
			let toast = document.getElementById('exportToast');
			if (!toast) {
				toast = document.createElement('div');
				toast.id = 'exportToast';
				toast.className = 'export-toast';
				toast.setAttribute('role', 'status');
				toast.setAttribute('aria-live', 'polite');
				document.body.appendChild(toast);
			}

			toast.hidden = false;
			toast.innerText = message;
			toast.className = tone === 'error' ? 'export-toast is-error is-visible' : 'export-toast is-visible';
			window.clearTimeout(exportToastTimer);
			exportToastTimer = window.setTimeout(function () {
				toast.classList.remove('is-visible');
				window.setTimeout(function () {
					toast.hidden = true;
				}, 240);
			}, 2400);
		}

		function showToast(message, tone) {
			showExportToast(message, tone);
		}

		async function handleCopyTargetClick(event) {
			const button = event.target.closest('[data-copy-target]');
			if (!button || !resultsDiv.contains(button)) return;

			event.preventDefault();
			const target = button.dataset.copyTarget || button.innerText.trim();
			if (!target) return;

			try {
				await writeTextToClipboard(target);
				showToast('已复制候选目标：' + target);
			} catch (error) {
				console.error('Failed to copy candidate target', error);
				showToast('复制失败，请检查浏览器权限', 'error');
			}
		}

		function normalizeCustomRegionCode(value) {
			return String(value || '').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase();
		}

		function updateCustomRegionField(shouldFocus) {
			if (!proxyRegionSelect || !customRegionField || !customRegionInput) return;

			const isCustom = proxyRegionSelect.value === 'custom';
			const selectedRegion = /^[A-Z]{2}$/.test(proxyRegionSelect.value) ? proxyRegionSelect.value : '';

			customRegionInput.disabled = !isCustom;
			customRegionInput.required = isCustom;
			customRegionInput.placeholder = isCustom ? 'US' : '';

			if (isCustom) {
				customRegionInput.value = normalizeCustomRegionCode(customRegionInput.value);
				if (shouldFocus) {
					window.setTimeout(function () {
						customRegionInput.focus();
					}, 0);
				}
			} else {
				customRegionInput.value = selectedRegion;
			}
		}

		function getSelectedFOFARegion() {
			if (!proxyRegionSelect) return '';

			if (proxyRegionSelect.value === 'custom') {
				const region = normalizeCustomRegionCode(customRegionInput ? customRegionInput.value : '');
				if (customRegionInput) {
					customRegionInput.value = region;
				}

				if (!/^[A-Z]{2}$/.test(region)) {
					showToast('请输入有效的两位国家代码', 'error');
					return null;
				}

				return region;
			}

			return /^[A-Z]{2}$/.test(proxyRegionSelect.value) ? proxyRegionSelect.value : '';
		}

		function openFOFA() {
			const region = getSelectedFOFARegion();
			const port = proxyPortSelect ? proxyPortSelect.value : '';

			if (region === null) return;

			if (!region) {
				showToast('请选择有效地区', 'error');
				return;
			}

			let regionQuery = '';
			if (region === 'HK' || region === 'TW' || region === 'MO') {
				regionQuery = 'region="' + region + '"';
			} else {
				regionQuery = 'country="' + region + '"';
			}

			let portQuery = '';
			if (port === '443') {
				portQuery = 'port="443"';
			} else if (port === 'nonstandard') {
				portQuery = '(port!="80" && port!="8080" && port!="8880" && port!="2052" && port!="2082" && port!="2086" && port!="2095" && port!="443" && port!="2053" && port!="2083" && port!="2087" && port!="2096" && port!="8443")';
			} else {
				showToast('请选择有效端口', 'error');
				return;
			}

			const query = 'server=="cloudflare" && header="Forbidden" && asn!="13335" && asn!="209242" && ' + regionQuery + ' && ' + portQuery;
			const qbase64 = btoa(query);
			const url = 'https://fofa.info/result?qbase64=' + encodeURIComponent(qbase64);
			window.open(url, '_blank', 'noopener');
		}

		async function handleExport(format) {
			const records = getExportableRecords();
			if (!records.length) {
				showExportToast('当前筛选没有可导出的有效结果', 'error');
				return;
			}

			try {
				if (format === 'csv') {
					downloadTextFile('\\ufeff' + buildCsvExport(records), getExportFileName('csv'), 'text/csv');
					showExportToast('已开始下载 CSV 文件');
					return;
				}

				const textContent = buildTextExport(records);
				if (!textContent) {
					showExportToast('当前筛选没有可导出的 TXT 内容', 'error');
					return;
				}

				if (format === 'clipboard') {
					await writeTextToClipboard(textContent);
					showExportToast('已经将结果导出到了粘贴板');
					return;
				}

				if (format === 'txt') {
					downloadTextFile(textContent, getExportFileName('txt'), 'text/plain');
					showExportToast('已开始下载 TXT 文件');
				}
			} catch (error) {
				console.error('Failed to export results', error);
				showExportToast(format === 'clipboard' ? '粘贴板写入失败，请检查浏览器权限' : '导出失败，请稍后重试', 'error');
			}
		}

		function getHistory() {
			try {
				const parsed = JSON.parse(localStorage.getItem('cf_proxy_history') || '[]');
				return Array.isArray(parsed) ? parsed : [];
			} catch {
				return [];
			}
		}

		function saveHistory(value) {
			if (!value || value.includes('\\n')) return;
			let history = getHistory();
			history = history.filter(function (item) {
				return item !== value;
			});
			history.unshift(value);
			history = history.slice(0, 10);
			localStorage.setItem('cf_proxy_history', JSON.stringify(history));
			renderHistory();
		}

		function selectHistory(value) {
			inputList.value = value;
			historyDropdown.style.display = 'none';
			inputList.focus();
		}

		function renderHistory() {
			const history = getHistory();
			historyDropdown.innerHTML = '';

			if (!history.length) {
				const emptyItem = document.createElement('button');
				emptyItem.type = 'button';
				emptyItem.className = 'history-item is-empty';
				emptyItem.innerText = '暂无历史记录';
				historyDropdown.appendChild(emptyItem);
				return;
			}

			history.forEach(function (item) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'history-item';
				button.innerText = item;
				button.addEventListener('click', function () {
					selectHistory(item);
				});
				historyDropdown.appendChild(button);
			});
		}

		function createInputControl(isBatch, value) {
			let control;

			if (isBatch) {
				control = document.createElement('textarea');
				control.placeholder = '每行一个目标，例如：\\n8.223.63.150\\n[2606:4700::]:443\\nProxyIP.CMLiussss.net';
			} else {
				control = document.createElement('input');
				control.type = 'text';
				control.placeholder = '例如：ProxyIP.CMLiussss.net 或 8.223.63.150:443';
			}

			control.id = 'inputList';
			control.className = 'input-control';
			control.value = isBatch ? normalizeBatchInputValue(value || '') : (value || '');
			return control;
		}

		function swapInputMode(isBatch) {
			const currentValue = inputList.value;
			const nextValue = isBatch ? currentValue : currentValue.split('\\n')[0];
			const nextControl = createInputControl(isBatch, nextValue);

			inputContainer.innerHTML = '';
			inputContainer.appendChild(nextControl);

			if (!isBatch) {
				inputContainer.appendChild(historyBtn);
				inputContainer.appendChild(historyDropdown);
			}

			inputList = nextControl;
			historyDropdown.style.display = 'none';
			setModeVisuals(isBatch);
			bindInputShortcut();
		}

		function formatLatency(value) {
			if (value === undefined || value === null || value === '') {
				return '延迟未知';
			}
			const text = String(value);
			return text.includes('ms') ? text : text + ' ms';
		}

		function getLatencyTooltipText(data) {
			const coloCode = normalizeColoCode(data?.colo);
			const coloText = coloCode ? 'Cloudflare ' + coloCode + ' 机房' : 'Cloudflare 测试机房';
			return '这个延迟不是你到 ProxyIP 的延迟，而是 ' + coloText + ' 到 ProxyIP 的检测延迟。';
		}

		function setLatencyTooltip(badge, data, latencyText) {
			if (!badge) return;
			const tooltipText = getLatencyTooltipText(data);
			badge.dataset.tooltip = tooltipText;
			badge.setAttribute('aria-label', latencyText + '。' + tooltipText);
		}

		function joinUniqueValues(values, fallback) {
			const uniqueValues = Array.from(new Set(values.filter(Boolean)));
			return uniqueValues.length ? uniqueValues.join(' / ') : fallback;
		}

		function formatExitLocation(exitData) {
			const country = String(exitData?.country || '').trim();
			const city = String(exitData?.city || '').trim();
			return [country, city].filter(Boolean).join(' · ');
		}

		function formatExitNetwork(exitData) {
			const asn = String(exitData?.asn || '').trim();
			const organization = String(exitData?.asOrganization || '').trim();

			if (asn && organization) {
				return 'AS' + asn + ' · ' + organization;
			}

			if (asn) {
				return 'AS' + asn;
			}

			return organization;
		}

		function getExitCountryCode(exitData) {
			const candidates = [
				exitData?.countryCode,
				exitData?.country_code,
				exitData?.countryIsoCode,
				exitData?.country_iso_code,
				exitData?.country
			];

			for (const candidate of candidates) {
				const normalized = String(candidate || '').trim().toLowerCase();
				if (/^[a-z]{2}$/.test(normalized)) {
					return normalized;
				}
			}

			return '';
		}

		function getFlagUrlFromCountryCode(countryCode) {
			const normalized = String(countryCode || '').trim().toLowerCase();
			return /^[a-z]{2}$/.test(normalized)
				? 'https://ipdata.co/flags/' + normalized + '.png'
				: '';
		}

		function getFlagUrlFromExitIps(exitIps) {
			for (const entry of exitIps) {
				const countryCode = getExitCountryCode(entry.exitData);
				if (countryCode) {
					return getFlagUrlFromCountryCode(countryCode);
				}
			}

			return '';
		}

		function updateResultFlag(itemObj, flagUrl) {
			if (!itemObj?.flag) return;

			if (flagUrl) {
				itemObj.el.classList.add('has-flag');
				itemObj.flag.style.backgroundImage = 'url("' + flagUrl + '")';
				return;
			}

			itemObj.el.classList.remove('has-flag');
			itemObj.flag.style.backgroundImage = '';
		}

		function getExitSelectionKey(exitData, fallbackIp) {
			return [
				String(exitData?.ip || fallbackIp || '').trim(),
				String(exitData?.ipType || '').trim().toLowerCase(),
				normalizeColoCode(exitData?.colo),
				String(exitData?.loc || '').trim()
			].join('|');
		}

		function buildExitDetailToggleIcon() {
			return '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">' +
				'<path d="M2.5 4.25L6 7.75L9.5 4.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>' +
				'</svg>';
		}

		async function copyExitIp(card, rawIp) {
			const value = String(rawIp || '').trim();
			if (!value) {
				return;
			}

			try {
				await writeTextToClipboard(value);
				showToast('已复制落地 IP：' + value);
				card.classList.add('is-copied');
				window.setTimeout(function () {
					card.classList.remove('is-copied');
				}, 1200);
			} catch (error) {
				console.error('Failed to copy exit IP', error);
				showToast('复制失败，请检查浏览器权限', 'error');
			}
		}

		function renderExitList(container, exitIps) {
			container.innerHTML = '';

			if (!exitIps.length) {
				const note = document.createElement('span');
				note.className = 'result-detail is-compact';
				note.innerText = '暂无可展示的出口详情';
				container.appendChild(note);
				return;
			}

			const label = document.createElement('span');
			label.className = 'exit-list-label';
			label.innerText = '落地 IP';
			container.appendChild(label);

			exitIps.forEach(function (entry) {
				const card = document.createElement('div');
				card.className = 'exit-ip-card';
				card.dataset.exitKey = getExitSelectionKey(entry.exitData, entry.ip);

				const copyButton = document.createElement('button');
				copyButton.type = 'button';
				copyButton.className = 'exit-ip-copy';
				copyButton.innerText = entry.ip;
				copyButton.title = '点击复制 IP';
				copyButton.setAttribute('aria-label', '复制落地 IP ' + entry.ip);
				copyButton.addEventListener('click', function () {
					copyExitIp(card, entry.ip);
				});

				const detailToggle = document.createElement('button');
				detailToggle.type = 'button';
				detailToggle.className = 'exit-ip-detail-toggle';
				detailToggle.title = '展开 / 收起 IP 详情';
				detailToggle.setAttribute('aria-label', '展开或收起落地 IP ' + entry.ip + ' 的详细信息');
				detailToggle.setAttribute('aria-expanded', 'false');
				detailToggle.innerHTML = buildExitDetailToggleIcon();
				detailToggle.addEventListener('click', function () {
					showDetails(card, entry.exitData);
				});

				card.appendChild(copyButton);
				card.appendChild(detailToggle);
				container.appendChild(card);
			});
		}

		function addResultItem(ip) {
			hideEmptyState();
			const div = document.createElement('div');
			div.className = 'result-item';
			div.innerHTML =
				'<div class="result-flag-overlay" aria-hidden="true"></div>' +
				'<div class="result-top">' +
					'<div class="result-info">' +
						'<span class="result-label">候选目标</span>' +
						buildCopyableTarget(ip) +
						'<span class="result-detail">已加入检测队列，正在等待返回结果。</span>' +
					'</div>' +
					'<span class="status-badge status-pending">等待中</span>' +
				'</div>' +
				'<div class="result-meta">' +
					buildMetaChip('准备建立检测请求', 'prep') +
				'</div>' +
				'<div class="exit-list"></div>' +
				'<div class="map-container-wrapper"></div>';

			resultsDiv.appendChild(div);

			const itemObj = {
				el: div,
				flag: div.querySelector('.result-flag-overlay'),
				info: div.querySelector('.result-info'),
				badge: div.querySelector('.status-badge'),
				meta: div.querySelector('.result-meta'),
				exitList: div.querySelector('.exit-list'),
				mapContainer: div.querySelector('.map-container-wrapper')
			};
			createResultRecord(ip, itemObj);
			return itemObj;
		}

		async function checkIP(target, itemObj, run) {
			if (isRunStopped(run)) return;
			itemObj = itemObj || addResultItem(target);
			const resultRecord = itemObj.record;

			try {
				const result = await fetchJsonWithTimeout(API_BASE + '/check?proxyip=' + encodeURIComponent(target), {}, 30000, run?.controller.signal);
				const data = result.payload || {
					success: false,
					message: '检测接口没有返回有效 JSON'
				};
				if (!result.response.ok) {
					data.success = false;
					data.message = data.message || ('HTTP ' + result.response.status);
				}
				completedCount++;

				if (data.success) {
					successCount++;
					itemObj.el.className = 'result-item success';
					const latency = formatLatency(data.responseTime);
					itemObj.badge.className = 'status-badge status-success';
					itemObj.badge.innerText = latency;
					setLatencyTooltip(itemObj.badge, data, latency);

					const exitIps = [];
					if (data.probe_results?.ipv4?.ok && data.probe_results.ipv4.exit) {
						exitIps.push({ stack: 'ipv4', ip: data.probe_results.ipv4.exit.ip, exitData: data.probe_results.ipv4.exit });
					}
					if (data.probe_results?.ipv6?.ok && data.probe_results.ipv6.exit) {
						exitIps.push({ stack: 'ipv6', ip: data.probe_results.ipv6.exit.ip, exitData: data.probe_results.ipv6.exit });
					}
					updateResultRecordAsSuccess(resultRecord, data, exitIps);

					const locations = joinUniqueValues(exitIps.map(function (entry) {
						return formatExitLocation(entry.exitData);
					}), '地区未知');
					const networks = joinUniqueValues(exitIps.map(function (entry) {
						return formatExitNetwork(entry.exitData);
					}), 'ASN / 运营商未知');
					const flagUrl = getFlagUrlFromExitIps(exitIps);

					updateResultFlag(itemObj, flagUrl);

					itemObj.info.innerHTML =
						'<span class="result-label">候选目标</span>' +
						buildCopyableTarget(data.candidate || target) +
						'<span class="result-detail">代理验证通过，可继续查看出口位置、网络信息和地图分布。</span>';

					const metaParts = [
						buildMetaChip(locations, 'location'),
						buildMetaChip(networks, 'network'),
						buildMetaChip(exitIps.length + '个出口', 'exits')
					];
					itemObj.meta.innerHTML = metaParts.join('');

					renderExitList(itemObj.exitList, exitIps);
				} else {
					updateResultRecordAsError(resultRecord, data);
					itemObj.el.className = 'result-item error';
					updateResultFlag(itemObj, '');
					itemObj.badge.className = 'status-badge status-error';
					itemObj.badge.innerText = '不可用';
					itemObj.info.innerHTML =
						'<span class="result-label">候选目标</span>' +
						buildCopyableTarget(target) +
						'<span class="result-detail">无法通过该代理访问 Cloudflare，请更换目标后重试。</span>';
					itemObj.meta.innerHTML =
						buildMetaChip('检测未通过', 'error', 'meta-chip-danger') +
						buildMetaChip(data.message || '远端返回失败结果', 'info');
					itemObj.exitList.innerHTML = '';
				}
			} catch (error) {
				if (isRunStopped(run)) {
					if (resultRecord) resultRecord.status = 'stopped';
					itemObj.badge.className = 'status-badge status-error';
					itemObj.badge.innerText = '已停止';
					itemObj.info.innerHTML =
						'<span class="result-label">候选目标</span>' +
						buildCopyableTarget(target) +
						'<span class="result-detail">检测已手动停止，未继续请求该目标。</span>';
					itemObj.meta.innerHTML = buildMetaChip('已停止', 'info');
					itemObj.exitList.innerHTML = '';
					updateProgress();
					updateResultFilters();
					return;
				}
				completedCount++;
				updateResultRecordAsError(resultRecord, null);
				itemObj.el.className = 'result-item error';
				updateResultFlag(itemObj, '');
				itemObj.badge.className = 'status-badge status-error';
				itemObj.badge.innerText = '失败';
				itemObj.info.innerHTML =
					'<span class="result-label">候选目标</span>' +
					buildCopyableTarget(target) +
					'<span class="result-detail">检测请求执行失败，可能是接口异常或网络中断。</span>';
				itemObj.meta.innerHTML =
					buildMetaChip('请求异常', 'error', 'meta-chip-danger') +
					buildMetaChip(error && error.name === 'AbortError' ? '检测请求超时' : '请稍后重试', 'retry');
				itemObj.exitList.innerHTML = '';
			}

			updateProgress();
			updateResultFilters();
		}

		async function showDetails(card, exitData) {
			const item = card.closest('.result-item');
			const container = item.querySelector('.map-container-wrapper');
			const isOpen = container.style.display === 'block';
			const nextSelectionKey = card.dataset.exitKey || getExitSelectionKey(exitData);
			const isSameSelection = isOpen && container.dataset.activeExitKey === nextSelectionKey;
			const currentToken = ++mapRenderToken;
			const toggle = card.querySelector('.exit-ip-detail-toggle');

			document.querySelectorAll('.map-container-wrapper').forEach(function (panel) {
				if (panel !== container) {
					panel.style.display = 'none';
					panel.dataset.activeExitKey = '';
				}
			});
			document.querySelectorAll('.exit-ip-card.is-active').forEach(function (activeCard) {
				activeCard.classList.remove('is-active');
				const activeToggle = activeCard.querySelector('.exit-ip-detail-toggle');
				if (activeToggle) {
					activeToggle.setAttribute('aria-expanded', 'false');
				}
			});

			if (isSameSelection) {
				container.style.display = 'none';
				container.dataset.activeExitKey = '';
				if (toggle) {
					toggle.setAttribute('aria-expanded', 'false');
				}
				return;
			}

			container.dataset.activeExitKey = nextSelectionKey;
			card.classList.add('is-active');
			if (toggle) {
				toggle.setAttribute('aria-expanded', 'true');
			}
			initMap();
			container.appendChild(globalMap);
			container.style.display = 'block';

			setTimeout(async function () {
				if (currentToken !== mapRenderToken || container.style.display !== 'block') {
					return;
				}

				map.invalidateSize();

				const exitLocation = parseCoordinatePair(exitData?.loc);
				await loadCfLocations();
				if (currentToken !== mapRenderToken || container.style.display !== 'block') {
					return;
				}

				const cfLocation = getCfLocation(exitData?.colo);
				const cfCoordinates = cfLocation ? [cfLocation.lat, cfLocation.lon] : null;
				const hasExitLocation = isValidCoordinatePair(exitLocation);
				const hasCfLocation = isValidCoordinatePair(cfCoordinates);

				clearMapLayers();

				if (hasExitLocation) {
					const exitMarker = L.circleMarker(exitLocation, {
						radius: 8,
						weight: 2,
						color: '#34d399',
						fillColor: '#34d399',
						fillOpacity: 0.3
					}).addTo(map);
					exitMarker.bindPopup(createExitPopup(exitData));
					mapLayers.push(exitMarker);
				}

				if (hasCfLocation) {
					const cfMarker = L.circleMarker(cfCoordinates, {
						radius: 8,
						weight: 2,
						color: '#61dbff',
						fillColor: '#61dbff',
						fillOpacity: 0.28
					}).addTo(map);
					cfMarker.bindPopup(createCfPopup(cfLocation));
					mapLayers.push(cfMarker);
				}

				if (hasExitLocation && hasCfLocation) {
					const transitLine = L.polyline([exitLocation, cfCoordinates], {
						color: '#8be9ff',
						weight: 2,
						opacity: 0.85,
						dashArray: '8 6',
						renderer: mapSvgRenderer
					}).addTo(map);
					mapLayers.push(transitLine);
					applyArrowStyleToPolyline(transitLine);
					map.fitBounds([exitLocation, cfCoordinates], {
						padding: [36, 36],
						maxZoom: 6
					});
					return;
				}

				if (hasExitLocation) {
					map.setView(exitLocation, 6);
					return;
				}

				if (hasCfLocation) {
					map.setView(cfCoordinates, 5);
					return;
				}

				map.setView([20, 0], 2);
			}, 100);
		}

		batchMode.addEventListener('change', function () {
			swapInputMode(batchMode.checked);
		});

		historyBtn.addEventListener('click', function (event) {
			event.stopPropagation();
			const isVisible = historyDropdown.style.display === 'block';
			historyDropdown.style.display = isVisible ? 'none' : 'block';
		});

		document.addEventListener('click', function (event) {
			if (!inputContainer.contains(event.target)) {
				historyDropdown.style.display = 'none';
			}
		});

		if (themeToggle) {
			themeToggle.addEventListener('click', function () {
				const currentTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
				const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
				try {
					localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
				} catch (error) {
					console.warn('Failed to persist theme preference', error);
				}
				applyTheme(nextTheme, 'stored');
			});
		}

		if (systemThemeQuery.addEventListener) {
			systemThemeQuery.addEventListener('change', function (event) {
				if (getStoredTheme()) return;
				applyTheme(event.matches ? 'dark' : 'light', 'system');
			});
		} else if (systemThemeQuery.addListener) {
			systemThemeQuery.addListener(function (event) {
				if (getStoredTheme()) return;
				applyTheme(event.matches ? 'dark' : 'light', 'system');
			});
		}

		filterToggle.addEventListener('click', function () {
			isFilterPanelExpanded = !isFilterPanelExpanded;
			updateResultFilters();
		});

		primaryFilterGroup.addEventListener('click', function (event) {
			const button = event.target.closest('[data-primary-filter]');
			if (!button || button.disabled) return;

			activePrimaryFilter = button.dataset.primaryFilter || 'all';
			activeCountryFilter = 'all';
			updateResultFilters();
		});

		countryFilterGroup.addEventListener('click', function (event) {
			const button = event.target.closest('[data-country-filter]');
			if (!button) return;

			activeCountryFilter = button.dataset.countryFilter || 'all';
			updateResultFilters();
		});

		if (exportGroup) {
			exportGroup.addEventListener('click', function (event) {
				const button = event.target.closest('[data-export-format]');
				if (!button) return;

				handleExport(button.dataset.exportFormat || '');
			});
		}

		if (proxyRegionSelect) {
			proxyRegionSelect.addEventListener('change', function () {
				updateCustomRegionField(true);
			});
		}

		if (customRegionInput) {
			customRegionInput.addEventListener('input', function () {
				const normalizedValue = normalizeCustomRegionCode(customRegionInput.value);
				if (customRegionInput.value !== normalizedValue) {
					customRegionInput.value = normalizedValue;
				}
			});
		}

		if (fofaBtn) {
			fofaBtn.addEventListener('click', openFOFA);
		}

		resultsDiv.addEventListener('click', handleCopyTargetClick);

		checkBtn.addEventListener('click', async function () {
			if (activeRun) {
				stopActiveRun();
				return;
			}

			const value = batchMode.checked ? normalizeBatchInputValue(inputList.value) : stripTargetLabel(inputList.value);
			if (!value) return;

			const lines = batchMode.checked
				? uniqueTargets(normalizeBatchInputValue(value).split('\\n').map(function (line) { return line.trim(); }).filter(Boolean))
				: [value];

			inputList.value = batchMode.checked ? lines.join('\\n') : value;

			if (!batchMode.checked) {
				saveHistory(value);
			}

			resultsDiv.innerHTML = '';
			resetResultFilters();
			progressBar.style.width = '0%';
			progressText.innerText = '正在解析目标...';
			showEmptyState('正在准备检测', '正在解析你输入的目标，请稍候。');

			completedCount = 0;
			successCount = 0;
			totalTargets = 0;
			inputCount = lines.length;

			const run = {
				controller: new AbortController(),
				cancelled: false
			};
			activeRun = run;
			setCheckButtonRunning(true);
			setAppState('resolving');

			try {
				const resolveJobs = [];
				const targetGroups = lines.map(function (line) {
					const directTarget = batchMode.checked ? getDirectIpTarget(line) : '';
					if (directTarget) {
						return [directTarget];
					}

					const group = [];
					resolveJobs.push({ line, group });
					return group;
				});

				if (batchMode.checked) {
					await resolveBatchJobs(resolveJobs, run);
				} else {
					for (const job of resolveJobs) {
						await resolveSingleJob(job, run);
					}
				}
				throwIfRunStopped(run);

				const allResolvedTargets = [];
				pushResolvedTargets(targetGroups, allResolvedTargets);

				if (allResolvedTargets.length > 0) {
					totalTargets = allResolvedTargets.length;
					setAppState('running');
					updateProgress();
					throwIfRunStopped(run);

					let checkJobs = [];
					isCreatingResultBatch = true;
					try {
						checkJobs = allResolvedTargets.map(function (target) {
							return {
								target: target,
								itemObj: addResultItem(target)
							};
						});
					} finally {
						isCreatingResultBatch = false;
					}
					updateResultFilters();

					await runWithConcurrency(checkJobs, CHECK_CONCURRENCY, function (job) {
						return checkIP(job.target, job.itemObj, run);
					}, run);
					throwIfRunStopped(run);

					const failCount = Math.max(totalTargets - successCount, 0);
					progressText.innerText = '总计 ' + totalTargets + ' · 有效 ' + successCount + ' · 失败 ' + failCount;
					setAppState('done');
				} else {
					progressText.innerText = '未解析到目标';
					showEmptyState('没有可检测的候选目标', '请检查输入格式，或确认域名是否存在 TXT / A / AAAA 记录。');
					setAppState('empty');
				}
			} catch (error) {
				if (isRunStopped(run) || error?.name === 'AbortError') {
					markPendingResultsStopped();
					if (!resultRecords.length) {
						showEmptyState('检测已停止', '本轮检测已手动停止，未继续解析或检测。');
					}
					progressText.innerText = '已停止 · 已完成 ' + completedCount + ' / ' + totalTargets + ' · 有效 ' + successCount;
					setAppState('stopped');
				} else {
					console.error(error);
					progressText.innerText = '系统错误';
					showEmptyState('检测流程中断', '请求过程中发生异常，请稍后重试。');
					setAppState('error');
				}
			} finally {
				if (activeRun === run) activeRun = null;
				setCheckButtonRunning(false);
			}
		});

		window.onload = function () {
			renderHistory();
			setModeVisuals(false);
			bindInputShortcut();
			renderDashboard();
			updateResultFilters();
			updateCustomRegionField();
			loadCfLocations();
			loadBackendServiceInfo();

			const path = window.location.pathname.slice(1);
			if (path && path.length > 3) {
				const decodedPath = decodeURIComponent(path);
				if (decodedPath !== 'resolve' && decodedPath !== 'favicon.ico') {
					inputList.value = decodedPath;
					window.history.replaceState({}, '', '/');
					checkBtn.click();
				}
			}
		};
	</script>
</body>
</html>`;
}

// ==================== local /check implementation ====================
/**
 * merged worker
 * TLS + target worker
 */

const e = 769, t = 771, n = 772, r = 20, i = 21, s = 22, a = 23, h = 1, c = 2, o = 4, l = 8, f = 11, u = 12, y = 13, p = 14, w = 15, d = 16, g = 20, k = 24, v = 0, A = 10, S = 11, m = 13, b = 16, C = 43, H = 45, T = 51, E = 0, L = new TextEncoder, K = new TextDecoder, P = new Uint8Array(0), U = new Map(Object.entries({ TLS_AES_128_GCM_SHA256: { id: 4865, keyLen: 16, ivLen: 12, hash: "SHA-256", tls13: !0 }, TLS_AES_256_GCM_SHA384: { id: 4866, keyLen: 32, ivLen: 12, hash: "SHA-384", tls13: !0 }, TLS_CHACHA20_POLY1305_SHA256: { id: 4867, keyLen: 32, ivLen: 12, hash: "SHA-256", tls13: !0, chacha: !0 }, TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: { id: 49199, keyLen: 16, ivLen: 4, hash: "SHA-256", kex: "ECDHE" }, TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384: { id: 49200, keyLen: 32, ivLen: 4, hash: "SHA-384", kex: "ECDHE" }, TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256: { id: 52392, keyLen: 32, ivLen: 12, hash: "SHA-256", kex: "ECDHE", chacha: !0 }, TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: { id: 49195, keyLen: 16, ivLen: 4, hash: "SHA-256", kex: "ECDHE" }, TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: { id: 49196, keyLen: 32, ivLen: 4, hash: "SHA-384", kex: "ECDHE" }, TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256: { id: 52393, keyLen: 32, ivLen: 12, hash: "SHA-256", kex: "ECDHE", chacha: !0 } }).map((([, e]) => [e.id, e]))), I = new Map([[29, "X25519"], [23, "P-256"]]), x = [2052, 2053, 2054, 1025, 1281, 1537, 1027, 1283, 1539], _ = (...e) => { const t = e => { const n = []; for (const r of e) r instanceof Uint8Array ? n.push(...r) : Array.isArray(r) ? n.push(...t(r)) : "number" == typeof r && n.push(r); return n }; return new Uint8Array(t(e)) }, B = e => [e >> 8 & 255, 255 & e], R = (e, t) => e[t] << 8 | e[t + 1], M = (e, t) => e[t] << 16 | e[t + 1] << 8 | e[t + 2], W = (...e) => { const t = e.filter((e => e && e.length > 0)), n = t.reduce(((e, t) => e + t.length), 0), r = new Uint8Array(n); let i = 0; for (const e of t) r.set(e, i), i += e.length; return r }, D = e => crypto.getRandomValues(new Uint8Array(e)), N = (e, t) => { if (!e || !t || e.length !== t.length) return !1; let n = 0; for (let r = 0; r < e.length; r++)n |= e[r] ^ t[r]; return 0 === n }, q = e => "SHA-512" === e ? 64 : "SHA-384" === e ? 48 : 32; async function $(e, t, n) { const r = await crypto.subtle.importKey("raw", t, { name: "HMAC", hash: e }, !1, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", r, n)) } async function G(e, t) { return new Uint8Array(await crypto.subtle.digest(e, t)) } async function V(e, t, n, r, i = "SHA-256") { const s = W(L.encode(t), n); let a = new Uint8Array(0), h = s; for (; a.length < r;) { h = await $(i, e, h); const t = await $(i, e, W(h, s)); a = W(a, t) } return a.slice(0, r) } async function X(e, t, n) { return t && t.length || (t = new Uint8Array(q(e))), $(e, t, n) } async function O(e, t, n, r, i) { const s = L.encode("tls13 " + n); return async function (e, t, n, r) { const i = q(e), s = Math.ceil(r / i); let a = new Uint8Array(0), h = new Uint8Array(0); for (let r = 1; r <= s; r++)h = await $(e, t, W(h, n, [r])), a = W(a, h); return a.slice(0, r) }(e, t, _(B(i), s.length, s, r.length, r), i) } async function F(e = "P-256") { if ("X25519" === e) { const e = await crypto.subtle.generateKey({ name: "X25519" }, !0, ["deriveBits"]); return { keyPair: e, publicKeyRaw: new Uint8Array(await crypto.subtle.exportKey("raw", e.publicKey)) } } const t = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: e }, !0, ["deriveBits"]); return { keyPair: t, publicKeyRaw: new Uint8Array(await crypto.subtle.exportKey("raw", t.publicKey)) } } async function Y(e, t, n = "P-256") { if ("X25519" === n) { const n = await crypto.subtle.importKey("raw", t, { name: "X25519" }, !1, []); return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: n }, e, 256)) } const r = await crypto.subtle.importKey("raw", t, { name: "ECDH", namedCurve: n }, !1, []), i = "P-384" === n ? 384 : "P-521" === n ? 528 : 256; return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: r }, e, i)) } async function j(e, t, n, r) { const i = await crypto.subtle.importKey("raw", e, { name: "AES-GCM" }, !1, ["encrypt"]); return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: t, additionalData: r, tagLength: 128 }, i, n)) } async function z(e, t, n, r) { const i = await crypto.subtle.importKey("raw", e, { name: "AES-GCM" }, !1, ["decrypt"]); return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: t, additionalData: r, tagLength: 128 }, i, n)) } function J(e, t) { return (e << t | e >>> 32 - t) >>> 0 } function Q(e, t, n, r, i) { e[t] = e[t] + e[n] >>> 0, e[i] = J(e[i] ^ e[t], 16), e[r] = e[r] + e[i] >>> 0, e[n] = J(e[n] ^ e[r], 12), e[t] = e[t] + e[n] >>> 0, e[i] = J(e[i] ^ e[t], 8), e[r] = e[r] + e[i] >>> 0, e[n] = J(e[n] ^ e[r], 7) } function Z(e, t, n) { const r = new Uint32Array(16); r[0] = 1634760805, r[1] = 857760878, r[2] = 2036477234, r[3] = 1797285236; const i = new DataView(e.buffer, e.byteOffset, e.byteLength); for (let e = 0; e < 8; e++)r[4 + e] = i.getUint32(4 * e, !0); r[12] = t; const s = new DataView(n.buffer, n.byteOffset, n.byteLength); r[13] = s.getUint32(0, !0), r[14] = s.getUint32(4, !0), r[15] = s.getUint32(8, !0); const a = new Uint32Array(r); for (let e = 0; e < 10; e++)Q(a, 0, 4, 8, 12), Q(a, 1, 5, 9, 13), Q(a, 2, 6, 10, 14), Q(a, 3, 7, 11, 15), Q(a, 0, 5, 10, 15), Q(a, 1, 6, 11, 12), Q(a, 2, 7, 8, 13), Q(a, 3, 4, 9, 14); for (let e = 0; e < 16; e++)a[e] = a[e] + r[e] >>> 0; return new Uint8Array(a.buffer.slice(0)) } function ee(e, t, n) { const r = new Uint8Array(n.length); let i = 1; for (let s = 0; s < n.length; s += 64) { const a = Z(e, i++, t), h = Math.min(64, n.length - s); for (let e = 0; e < h; e++)r[s + e] = n[s + e] ^ a[e] } return r } function te(e, t) { const n = function (e) { const t = new Uint8Array(e); return t[3] &= 15, t[7] &= 15, t[11] &= 15, t[15] &= 15, t[4] &= 252, t[8] &= 252, t[12] &= 252, t }(e.slice(0, 16)), r = e.slice(16, 32); let i = [0n, 0n, 0n, 0n, 0n]; const s = [0x3ffffffn & BigInt(n[0] | n[1] << 8 | n[2] << 16 | n[3] << 24), 0x3ffffffn & BigInt(n[3] >> 2 | n[4] << 6 | n[5] << 14 | n[6] << 22), 0x3ffffffn & BigInt(n[6] >> 4 | n[7] << 4 | n[8] << 12 | n[9] << 20), 0x3ffffffn & BigInt(n[9] >> 6 | n[10] << 2 | n[11] << 10 | n[12] << 18), 0x3ffffffn & BigInt(n[13] | n[14] << 8 | n[15] << 16)]; for (let e = 0; e < t.length; e += 16) { const n = t.slice(e, e + 16), r = new Uint8Array(17); r.set(n), r[n.length] = 1, i[0] += BigInt(r[0] | r[1] << 8 | r[2] << 16 | (3 & r[3]) << 24), i[1] += BigInt(r[3] >> 2 | r[4] << 6 | r[5] << 14 | (15 & r[6]) << 22), i[2] += BigInt(r[6] >> 4 | r[7] << 4 | r[8] << 12 | (63 & r[9]) << 20), i[3] += BigInt(r[9] >> 6 | r[10] << 2 | r[11] << 10 | r[12] << 18), i[4] += BigInt(r[13] | r[14] << 8 | r[15] << 16 | r[16] << 24); const a = [0n, 0n, 0n, 0n, 0n]; for (let e = 0; e < 5; e++)for (let t = 0; t < 5; t++) { const n = e + t; n < 5 ? a[n] += i[e] * s[t] : a[n - 5] += i[e] * s[t] * 5n } let h = 0n; for (let e = 0; e < 5; e++)a[e] += h, i[e] = 0x3ffffffn & a[e], h = a[e] >> 26n; i[0] += 5n * h, h = i[0] >> 26n, i[0] &= 0x3ffffffn, i[1] += h } let a = i[0] | i[1] << 26n | i[2] << 52n | i[3] << 78n | i[4] << 104n; a = a + r.reduce(((e, t, n) => e + (BigInt(t) << BigInt(8 * n))), 0n) & (1n << 128n) - 1n; const h = new Uint8Array(16); for (let e = 0; e < 16; e++)h[e] = Number(a >> BigInt(8 * e) & 0xffn); return h } function ne(e, t, n, r) { const i = Z(e, 0, t).slice(0, 32), s = ee(e, t, n), a = (16 - r.length % 16) % 16, h = (16 - s.length % 16) % 16, c = new Uint8Array(r.length + a + s.length + h + 16); c.set(r, 0), c.set(s, r.length + a); const o = new DataView(c.buffer, r.length + a + s.length + h); o.setBigUint64(0, BigInt(r.length), !0), o.setBigUint64(8, BigInt(s.length), !0); const l = te(i, c); return W(s, l) } function re(e, t, n, r) { if (n.length < 16) throw new Error("Ciphertext too short"); const i = n.slice(-16), s = n.slice(0, -16), a = Z(e, 0, t).slice(0, 32), h = (16 - r.length % 16) % 16, c = (16 - s.length % 16) % 16, o = new Uint8Array(r.length + h + s.length + c + 16); o.set(r, 0), o.set(s, r.length + h); const l = new DataView(o.buffer, r.length + h + s.length + c); l.setBigUint64(0, BigInt(r.length), !0), l.setBigUint64(8, BigInt(s.length), !0); const f = te(a, o); let u = 0; for (let e = 0; e < 16; e++)u |= i[e] ^ f[e]; if (0 !== u) throw new Error("ChaCha20-Poly1305 authentication failed"); return ee(e, t, s) } function ie(e, n, r = t) { return _(e, B(r), B(n.length), n) } function se(e, t) { return _(e, (e => [e >> 16 & 255, e >> 8 & 255, 255 & e])(t.length), t) } class ae { constructor() { this.buffer = new Uint8Array(0) } feed(e) { this.buffer = W(this.buffer, e) } next() { if (this.buffer.length < 5) return null; const e = this.buffer[0], t = R(this.buffer, 1), n = R(this.buffer, 3); if (this.buffer.length < 5 + n) return null; const r = this.buffer.slice(5, 5 + n); return this.buffer = this.buffer.slice(5 + n), { type: e, version: t, length: n, fragment: r } } } class he { constructor() { this.buffer = new Uint8Array(0) } feed(e) { this.buffer = W(this.buffer, e) } next() { if (this.buffer.length < 4) return null; const e = this.buffer[0], t = M(this.buffer, 1); if (this.buffer.length < 4 + t) return null; const n = this.buffer.slice(4, 4 + t), r = this.buffer.slice(0, 4 + t); return this.buffer = this.buffer.slice(4 + t), { type: e, length: t, body: n, raw: r } } } function ce(e) { let t = 0; const r = R(e, t); t += 2; const i = e.slice(t, t + 32); t += 32; const s = e[t++], a = e.slice(t, t + s); t += s; const h = R(e, t); t += 2; const c = e[t++]; let o = r, l = null, f = null; if (t < e.length) { const n = R(e, t); t += 2; const r = t + n; for (; t + 4 <= r;) { const n = R(e, t); t += 2; const r = R(e, t); t += 2; const i = e.slice(t, t + r); if (t += r, n === C && r >= 2) o = R(i, 0); else if (n === T && r >= 4) { const e = R(i, 0), t = R(i, 2); l = { group: e, key: i.slice(4, 4 + t) } } else n === b && r >= 3 && (f = K.decode(i.slice(3, 3 + i[2]))) } } const u = new Uint8Array([207, 33, 173, 116, 229, 154, 97, 17, 190, 29, 140, 2, 30, 101, 184, 145, 194, 162, 17, 22, 122, 187, 140, 94, 7, 158, 9, 226, 200, 168, 51, 156]); return { version: r, serverRandom: i, sessionId: a, cipherSuite: h, compression: c, selectedVersion: o, keyShare: l, alpn: f, isHRR: N(i, u), isTls13: o === n } } function oe(e) { let t = 0; t++; const n = R(e, t); t += 2; const r = e[t++]; return { namedCurve: n, serverPublicKey: e.slice(t, t + r) } } function le(e, t = 0) { let n = 0; if (t) { const t = e[n++]; n += t } if (n + 3 > e.length) return null; const r = M(e, n); if (n += 3, !r || n + 3 > e.length) return null; const i = M(e, n); return n += 3, i ? e.slice(n, n + i) : null } function fe(e) { const t = { alpn: null }; let n = 2; const r = 2 + R(e, 0); for (; n + 4 <= r;) { const r = R(e, n); n += 2; const i = R(e, n); if (n += 2, r === b && i >= 3) { const r = e[n + 2]; r > 0 && n + 3 + r <= n + i && (t.alpn = K.decode(e.slice(n + 3, n + 3 + r))) } n += i } return t } const F0 = e => { if (e = String(e ?? "").trim(), "[" === e[0] && "]" === e[e.length - 1] && (e = e.slice(1, -1)), !e || e.includes(":")) return ""; const t = e.split("."); if (4 !== t.length) return e; for (const n of t) { if ("" === n || n.length > 3) return e; let t = 0; for (let r = 0; r < n.length; r++) { const i = n.charCodeAt(r) - 48; if (i < 0 || i > 9) return e; t = 10 * t + i } if (t > 255) return e } return "" }, Z0 = e => e && 1 === e[0] && 112 === e[1]; function ue(e, n, r, { tls13: i = !0, tls12: s = !0, alpn: a = null } = {}) { n = F0(n); const c = []; i && c.push(4865, 4866, 4867), s && c.push(49199, 49200, 52392, 49195, 49196, 52393); const o = _(...c.flatMap(B)), l = [_(255, 1, 0, 1, 0)]; if (n) { const e = L.encode(n), t = _(0, B(e.length), e); l.push(_(B(v), B(t.length + 2), B(t.length), t)) } l.push(_(B(S), 0, 2, 1, 0)), l.push(_(B(A), 0, 6, 0, 4, 0, 29, 0, 23)); const f = _(...x.flatMap(B)); l.push(_(B(m), B(f.length + 2), B(f.length), f)); const u = Array.isArray(a) ? a.filter(Boolean) : a ? [a] : []; if (u.length) { const e = W(...u.map((e => { const t = L.encode(e); return _(t.length, t) }))); l.push(_(B(b), B(e.length + 2), B(e.length), e)) } if (i && r) { let e; if (l.push(s ? _(B(C), 0, 5, 4, 3, 4, 3, 3) : _(B(C), 0, 3, 2, 3, 4)), l.push(_(B(H), 0, 2, 1, 1)), r?.x25519 && r?.p256) e = W(_(0, 29, B(r.x25519.length), r.x25519), _(0, 23, B(r.p256.length), r.p256)); else if (r?.x25519) e = _(0, 29, B(r.x25519.length), r.x25519); else if (r?.p256) e = _(0, 23, B(r.p256.length), r.p256); else { if (!(r instanceof Uint8Array)) throw new Error("Invalid keyShares"); e = _(0, 23, B(r.length), r) } l.push(_(B(T), B(e.length + 2), B(e.length), e)) } const y = W(...l); return se(h, _(B(t), e, 0, B(o.length), o, 1, 0, B(y.length), y)) } const ye = e => { const t = new Uint8Array(8); return new DataView(t.buffer).setBigUint64(0, e, !1), t }, pe = (e, t) => { const n = e.slice(), r = ye(t); for (let e = 0; e < 8; e++)n[n.length - 8 + e] ^= r[e]; return n }, we = (e, t, n, r) => Promise.all([O(e, t, "key", P, n), O(e, t, "iv", P, r)]); class TlsClient { constructor(e, t = {}) { if (this.socket = e, this.serverName = t.serverName || "", this.supportTls13 = !1 !== t.tls13, this.supportTls12 = !1 !== t.tls12, !this.supportTls13 && !this.supportTls12) throw new Error("At least one TLS version must be enabled"); this.alpnProtocols = Array.isArray(t.alpn) ? t.alpn : t.alpn ? [t.alpn] : null, this.timeout = t.timeout ?? 3e4, this.clientRandom = D(32), this.serverRandom = null, this.handshakeChunks = [], this.handshakeComplete = !1, this.negotiatedAlpn = null, this.cipherSuite = null, this.cipherConfig = null, this.isTls13 = !1, this.masterSecret = null, this.handshakeSecret = null, this.clientWriteKey = null, this.serverWriteKey = null, this.clientWriteIv = null, this.serverWriteIv = null, this.clientHandshakeKey = null, this.serverHandshakeKey = null, this.clientHandshakeIv = null, this.serverHandshakeIv = null, this.clientAppKey = null, this.serverAppKey = null, this.clientAppIv = null, this.serverAppIv = null, this.clientSeqNum = 0n, this.serverSeqNum = 0n, this.recordParser = new ae, this.handshakeParser = new he, this.keyPairs = new Map, this.ecdhKeyPair = null, this.sawCert = !1 } recordHandshake(e) { this.handshakeChunks.push(e) } transcript() { return 1 === this.handshakeChunks.length ? this.handshakeChunks[0] : W(...this.handshakeChunks) } getCipherConfig(e) { return U.get(e) || null } async readChunk(e) { if (!this.timeout) return e.read(); let t; const n = e.read(), r = await Promise.race([n, new Promise(e => t = setTimeout(e, this.timeout, 0))]).finally(() => clearTimeout(t)); if (r) return r; try { await e.cancel("TLS read timeout") } catch { } try { await n } catch { } throw new Error("TLS read timeout") } async pr(e, t, n) { for (; ;) { let r; for (; r = this.recordParser.next();)if (await t(r)) return; const { value: i, done: s } = await this.readChunk(e); if (s) throw new Error(n); this.recordParser.feed(i) } } async ph(e, t, n) { for (let e; e = this.handshakeParser.next();)if (await t(e)) return; return this.pr(e, (async e => { if (e.type === i) { if (Z0(e.fragment)) return; throw new Error(`TLS Alert: ${e.fragment[1]}`) } if (e.type === s) { this.handshakeParser.feed(e.fragment); for (let e; e = this.handshakeParser.next();)if (await t(e)) return 1 } }), n) } async acceptCertificate(e) { if (!e?.length) throw new Error("Empty certificate"); this.sawCert = !0 } async handshake() { const [t, n] = await Promise.all([F("P-256"), F("X25519")]); this.keyPairs = new Map([[23, t], [29, n]]), this.ecdhKeyPair = t.keyPair; const r = this.socket.readable.getReader(), i = this.socket.writable.getWriter(); try { const a = ue(this.clientRandom, this.serverName, { x25519: n.publicKeyRaw, p256: t.publicKeyRaw }, { tls13: this.supportTls13, tls12: this.supportTls12, alpn: this.alpnProtocols }); this.recordHandshake(a), await i.write(ie(s, a, e)); const h = await this.receiveServerHello(r); if (h.isHRR) throw new Error("HelloRetryRequest is not supported by TLSClientMini"); if (h.keyShare?.group && this.keyPairs.has(h.keyShare.group)) { const e = this.keyPairs.get(h.keyShare.group); this.ecdhKeyPair = e.keyPair } h.isTls13 ? await this.handshakeTls13(r, i, h) : await this.handshakeTls12(r, i), this.handshakeComplete = !0 } finally { r.releaseLock(), i.releaseLock() } } async receiveServerHello(e) { for (; ;) { const { value: t, done: n } = await this.readChunk(e); if (n) throw new Error("Connection closed waiting for ServerHello"); let r; for (this.recordParser.feed(t); r = this.recordParser.next();) { if (r.type === i) { if (Z0(r.fragment)) continue; throw new Error(`TLS Alert: level=${r.fragment[0]}, desc=${r.fragment[1]}`) } if (r.type !== s) continue; let e; for (this.handshakeParser.feed(r.fragment); e = this.handshakeParser.next();) { if (e.type !== c) continue; this.recordHandshake(e.raw); const t = ce(e.body); if (this.serverRandom = t.serverRandom, this.cipherSuite = t.cipherSuite, this.cipherConfig = this.getCipherConfig(t.cipherSuite), this.isTls13 = t.isTls13, this.negotiatedAlpn = t.alpn || null, !this.cipherConfig) throw new Error(`Unsupported cipher suite: 0x${t.cipherSuite.toString(16)}`); return t } } } } async handshakeTls12(e, t) { let n = null, a = !1; if (await this.ph(e, (async e => { switch (e.type) { case f: { this.recordHandshake(e.raw); const t = le(e.body, 1); if (!t) throw new Error("Missing TLS 1.2 certificate"); await this.acceptCertificate(t); break } case u: this.recordHandshake(e.raw), n = oe(e.body); break; case p: return this.recordHandshake(e.raw), a = !0, 1; case y: throw new Error("Client certificate is not supported"); default: this.recordHandshake(e.raw) } }), "Connection closed during TLS 1.2 handshake"), !this.sawCert) throw new Error("Missing TLS 1.2 leaf certificate"); if (!n) throw new Error("Missing TLS 1.2 ServerKeyExchange"); const h = I.get(n.namedCurve); if (!h) throw new Error(`Unsupported named curve: 0x${n.namedCurve.toString(16)}`); const c = this.keyPairs.get(n.namedCurve); if (!c) throw new Error(`Missing key pair for curve: 0x${n.namedCurve.toString(16)}`); const o = await Y(c.keyPair.privateKey, n.serverPublicKey, h), l = se(d, _(c.publicKeyRaw.length, c.publicKeyRaw)); this.recordHandshake(l); const w = this.cipherConfig.hash; this.masterSecret = await V(o, "master secret", W(this.clientRandom, this.serverRandom), 48, w); const k = this.cipherConfig.keyLen, v = this.cipherConfig.ivLen, A = await V(this.masterSecret, "key expansion", W(this.serverRandom, this.clientRandom), 2 * k + 2 * v, w); this.clientWriteKey = A.slice(0, k), this.serverWriteKey = A.slice(k, 2 * k), this.clientWriteIv = A.slice(2 * k, 2 * k + v), this.serverWriteIv = A.slice(2 * k + v, 2 * k + 2 * v), await t.write(ie(s, l)), await t.write(ie(r, _(1))); const S = await V(this.masterSecret, "client finished", await G(w, this.transcript()), 12, w), m = se(g, S); this.recordHandshake(m), await t.write(ie(s, await this.encryptTls12(m, s))); let b = !1; await this.pr(e, (async e => { if (e.type === i) { if (Z0(e.fragment)) return; throw new Error(`TLS Alert: ${e.fragment[1]}`) } if (e.type === r) return void (b = !0); if (e.type !== s || !b) return; const t = await this.decryptTls12(e.fragment, s); if (t[0] !== g) return; const n = M(t, 1), a = t.slice(4, 4 + n), h = await V(this.masterSecret, "server finished", await G(w, this.transcript()), 12, w); if (!N(a, h)) throw new Error("TLS 1.2 server Finished verify failed"); return 1 }), "Connection closed waiting for TLS 1.2 Finished") } async handshakeTls13(e, t, n) { const h = I.get(n.keyShare?.group); if (!h || !n.keyShare?.key?.length) throw new Error("Missing TLS 1.3 key_share"); const c = this.cipherConfig.hash, o = q(c), u = this.cipherConfig.keyLen, p = this.cipherConfig.ivLen, d = await Y(this.ecdhKeyPair.privateKey, n.keyShare.key, h), k = await X(c, null, new Uint8Array(o)), v = await O(c, k, "derived", await G(c, P), o); this.handshakeSecret = await X(c, v, d); const A = await G(c, this.transcript()), S = await O(c, this.handshakeSecret, "c hs traffic", A, o), m = await O(c, this.handshakeSecret, "s hs traffic", A, o);[this.clientHandshakeKey, this.clientHandshakeIv] = await we(c, S, u, p), [this.serverHandshakeKey, this.serverHandshakeIv] = await we(c, m, u, p); const b = await O(c, m, "finished", P, o); let C = !1; const H = async e => { switch (e.type) { case l: { const t = fe(e.body); t.alpn && (this.negotiatedAlpn = t.alpn), this.recordHandshake(e.raw); break } case f: { const t = le(e.body); if (!t) throw new Error("Missing TLS 1.3 certificate"); await this.acceptCertificate(t), this.recordHandshake(e.raw); break } case y: throw new Error("Client certificate is not supported"); case w: this.recordHandshake(e.raw); break; case g: { const t = await $(c, b, await G(c, this.transcript())); if (!N(t, e.body)) throw new Error("TLS 1.3 server Finished verify failed"); this.recordHandshake(e.raw), C = !0; break } default: this.recordHandshake(e.raw) } }; await this.pr(e, (async e => { if (e.type === r || e.type === s) return; if (e.type === i) { if (Z0(e.fragment)) return; throw new Error(`TLS Alert: ${e.fragment[1]}`) } if (e.type !== a) return; const t = await this.decryptTls13Handshake(e.fragment), n = t[t.length - 1], h = t.slice(0, -1); if (n === s) { this.handshakeParser.feed(h); for (let e; e = this.handshakeParser.next();)if (await H(e), C) return 1 } }), "Connection closed during TLS 1.3 handshake"); const T = await G(c, this.transcript()), E = await O(c, this.handshakeSecret, "derived", await G(c, P), o), L = await X(c, E, new Uint8Array(o)), K = await O(c, L, "c ap traffic", T, o), U = await O(c, L, "s ap traffic", T, o);[this.clientAppKey, this.clientAppIv] = await we(c, K, u, p), [this.serverAppKey, this.serverAppIv] = await we(c, U, u, p); const x = await O(c, S, "finished", P, o), _ = await $(c, x, await G(c, this.transcript())), B = se(g, _); this.recordHandshake(B), await t.write(ie(a, await this.encryptTls13Handshake(W(B, [s])))), this.clientSeqNum = 0n, this.serverSeqNum = 0n } async encryptTls12(e, n) { const r = this.clientSeqNum++, i = ye(r), s = W(i, [n], B(t), B(e.length)); if (this.cipherConfig.chacha) { const t = pe(this.clientWriteIv, r); return ne(this.clientWriteKey, t, e, s) } const a = D(8); return W(a, await j(this.clientWriteKey, W(this.clientWriteIv, a), e, s)) } async decryptTls12(e, n) { const r = this.serverSeqNum++, i = ye(r); if (this.cipherConfig.chacha) { const s = pe(this.serverWriteIv, r); return re(this.serverWriteKey, s, e, W(i, [n], B(t), B(e.length - 16))) } const s = e.slice(0, 8), a = e.slice(8); return z(this.serverWriteKey, W(this.serverWriteIv, s), a, W(i, [n], B(t), B(a.length - 16))) } async encryptTls13Handshake(e) { const t = pe(this.clientHandshakeIv, this.clientSeqNum++), n = _(a, 3, 3, B(e.length + 16)); return this.cipherConfig.chacha ? ne(this.clientHandshakeKey, t, e, n) : j(this.clientHandshakeKey, t, e, n) } async decryptTls13Handshake(e) { const t = pe(this.serverHandshakeIv, this.serverSeqNum++), n = _(a, 3, 3, B(e.length)), r = await (this.cipherConfig.chacha ? re(this.serverHandshakeKey, t, e, n) : z(this.serverHandshakeKey, t, e, n)); let i = r.length - 1; for (; i >= 0 && !r[i];)i--; return i < 0 ? P : r.slice(0, i + 1) } async encryptTls13(e) { const t = W(e, [a]), n = pe(this.clientAppIv, this.clientSeqNum++), r = _(a, 3, 3, B(t.length + 16)); return this.cipherConfig.chacha ? ne(this.clientAppKey, n, t, r) : j(this.clientAppKey, n, t, r) } async decryptTls13(e) { const t = pe(this.serverAppIv, this.serverSeqNum++), n = _(a, 3, 3, B(e.length)), r = this.cipherConfig.chacha ? await re(this.serverAppKey, t, e, n) : await z(this.serverAppKey, t, e, n); let i = r.length - 1; for (; i >= 0 && !r[i];)i--; return i < 0 ? { data: P, type: 0 } : { data: r.slice(0, i), type: r[i] } } async write(e) { if (!this.handshakeComplete) throw new Error("Handshake not complete"); const t = this.socket.writable.getWriter(); try { this.isTls13 ? await t.write(ie(a, await this.encryptTls13(e))) : await t.write(ie(a, await this.encryptTls12(e, a))) } finally { t.releaseLock() } } async read() { for (; ;) { let e; for (; e = this.recordParser.next();) { if (e.type === i) { if (e.fragment[1] === E) return null; throw new Error(`TLS Alert: ${e.fragment[1]}`) } if (e.type !== a) continue; if (!this.isTls13) return this.decryptTls12(e.fragment, a); const { data: t, type: n } = await this.decryptTls13(e.fragment); if (n === a) return t; if (n === i) { if (t[1] === E) return null; throw new Error(`TLS Alert: ${t[1]}`) } if (n !== s) continue; let r; for (this.handshakeParser.feed(t); r = this.handshakeParser.next();)if (r.type !== o && r.type === k) throw new Error("TLS 1.3 KeyUpdate is not supported by TLSClientMini") } const t = this.socket.readable.getReader(); try { const { value: e, done: n } = await this.readChunk(t); if (n) return null; this.recordParser.feed(e) } finally { t.releaseLock() } } } close() { this.socket.close() } }

// ==================== merged target ====================
import { connect } from 'cloudflare:sockets';
const enc = L;
const dec = K;

const DEFAULT_TIMEOUT_MS = 9999;
const DEFAULT_READ_LIMIT = 65536;

const CRLF = Uint8Array.of(13, 10);
const HEADER_BODY_SEPARATOR = Uint8Array.of(13, 10, 13, 10);

const HTTP_STATUS_RE = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/;
const CHUNKED_TRANSFER_RE = /\r\ntransfer-encoding:\s*chunked\r\n/i;

const USAGE_EXAMPLES = [
	'GET /check?proxyip=118.34.215.56:34042',
	"POST JSON {'proxyip':'118.34.215.56:34042'}",
];

const CHECK_RESPONSE_HEADERS = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'Content-Type',
};

// 用两个固定探针分别测试出口：
// - 访问 ipv4.090227.xyz 看返回的出口 IP
// - 访问 ipv6.090227.xyz 看返回的出口 IP
// 最终是否“支持 IPv4/IPv6”取决于探针返回的出口 IP 文本，不是候选代理地址本身。
const PROBE_TARGETS = [
	['ipv4', 'ipv4.090227.xyz', '/'],
	['ipv6', 'ipv6.090227.xyz', '/'],
].map(([name, host, path]) => ({
	name,
	host,
	request: enc.encode(
		`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/json, text/plain, */*\r\nAccept-Language: en-US,en;q=0.9\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`
	),
}));

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(`${value ?? ''}`, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function concatBytes(chunks) {
	const merged = new Uint8Array(chunks.reduce((sum, { length }) => sum + length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return merged;
}

function withTimeout(promise, timeoutMs, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
				timeoutMs
			);
		}),
	]).finally(() => clearTimeout(timer));
}

function indexOfBytes(haystack, needle, start = 0) {
	outer: for (let i = start; i <= haystack.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				continue outer;
			}
		}
		return i;
	}
	return -1;
}

function pickExitIp(payload) {
	// 探针 JSON 里优先取 ip，兼容部分接口用 ipAddress 命名。
	const ip = payload?.ip ?? payload?.ipAddress;
	return typeof ip === 'string' && ip ? ip : null;
}

function checkJsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: CHECK_RESPONSE_HEADERS,
	});
}

// 优先使用探针返回的 ipType；若没有 ipType，再回退到根据出口 IP 字符串判定。
function getExitFamily(result) {
	if (!result?.ok) return null;
	const ipType = `${result?.exit?.ipType ?? ''}`.toLowerCase();
	if (ipType === 'ipv4' || ipType === 'ipv6') return ipType;
	const exitIp = pickExitIp(result.exit) ?? '';
	// IPv4：必须匹配 x.x.x.x 且每段 0-255。
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(exitIp) && exitIp.split('.').every((part) => Number(part) <= 255)) return 'ipv4';
	// IPv6：当前逻辑只要包含 ":" 就视为 IPv6（未做完整 RFC 严格校验）。
	if (exitIp.includes(':')) return 'ipv6';
	return null;
}

async function handleCheckProxyRequest(req) {
	if (req.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: CHECK_RESPONSE_HEADERS,
		});
	}

	if (req.method !== 'GET' && req.method !== 'POST') {
		return checkJsonResponse(
			{ success: false, error: 'method not allowed', usage: USAGE_EXAMPLES },
			405
		);
	}

	try {
		const url = new URL(req.url);
		const pathname = url.pathname.replace(/\/+$/, '') || '/';
		if (pathname !== '/check') {
			return checkJsonResponse(
				{ success: false, error: 'not found', usage: USAGE_EXAMPLES },
				404
			);
		}

		const { searchParams } = url;
		const bodyText = req.method === 'POST' ? await req.text() : '';
		const body = bodyText ? JSON.parse(bodyText) : {};

		const rawCandidates = body.proxyips ?? body.proxyip ?? searchParams.get('proxyip');

		const rawList = Array.isArray(rawCandidates) ? rawCandidates : `${rawCandidates ?? ''}`.split(/[\s,]+/);
		const candidates = [...new Set(rawList.map((item) => `${item ?? ''}`.trim()).filter(Boolean))];
		const timeoutMs = parsePositiveInt(body.timeoutMs ?? searchParams.get('timeoutMs'), DEFAULT_TIMEOUT_MS);
		const readLimit = parsePositiveInt(body.readLimit ?? searchParams.get('readLimit'), DEFAULT_READ_LIMIT);

		if (!candidates.length) {
			return checkJsonResponse(
				{ success: false, error: 'missing proxyip', usage: USAGE_EXAMPLES },
				400
			);
		}

		const results = await Promise.all(
			candidates.map(async (rawCandidate) => {
				const defaultPort = 443;
				let candidate;
				if (rawCandidate.startsWith('[')) {
					const match = rawCandidate.match(/^\[([^\]]+)\](?::(\d+))?$/);
					if (!match) throw new Error(`invalid IPv6 candidate: ${rawCandidate}`);
					candidate = { raw: rawCandidate, hostname: match[1], port: Number(match[2]) || defaultPort };
				} else {
					const [, hostname = rawCandidate, port] = rawCandidate.match(/^([^:]+):(\d+)$/) ?? [];
					candidate = { raw: rawCandidate, hostname, port: Number(port) || defaultPort };
				}

				const probeResults = await Promise.all(
					PROBE_TARGETS.map(async (target) => {
						let socket = null;
						let tlsClient = null;

						let connectMs = null;
						let tlsMs = null;
						let httpMs = null;
						let statusCode = null;

						const buildResult = (
							ok,
							resultStatusCode,
							error,
							{ exit = null } = {}
						) => ({

							candidate: candidate.raw,
							connect_ms: connectMs,
							tls_ms: tlsMs,
							http_ms: httpMs,
							status_code: resultStatusCode,
							ok,
							error,
							exit,
						});

						try {
							let startedAt = Date.now();
							const hostAddr = candidate.hostname.includes(':') ? `[${candidate.hostname}]` : candidate.hostname;
							socket = connect({ hostname: hostAddr, port: candidate.port });
							await withTimeout(socket.opened, timeoutMs, 'tcp connect');
							connectMs = Date.now() - startedAt;

							startedAt = Date.now();
							tlsClient = new TlsClient(socket, { serverName: target.host, timeout: timeoutMs });
							await withTimeout(tlsClient.handshake(), timeoutMs, 'tls handshake');
							tlsMs = Date.now() - startedAt;

							startedAt = Date.now();
							await withTimeout(tlsClient.write(target.request), timeoutMs, 'http write');
							const chunks = [];
							for (let read = 0; read < readLimit;) {
								const chunk = (await withTimeout(tlsClient.read(), timeoutMs, 'http read'))?.subarray(0, readLimit - read);
								if (!chunk?.length) {
									break;
								}
								chunks.push(chunk);
								read += chunk.length;
							}
							const rawResponse = concatBytes(chunks);
							httpMs = Date.now() - startedAt;

							if (!rawResponse.length) return buildResult(false, null, 'empty response');

							const splitIndex = indexOfBytes(rawResponse, HEADER_BODY_SEPARATOR);
							const [headerBytes, bodyBytes] = splitIndex < 0
								? [rawResponse, new Uint8Array(0)]
								: [rawResponse.subarray(0, splitIndex), rawResponse.subarray(splitIndex + HEADER_BODY_SEPARATOR.length)];
							const headerText = dec.decode(headerBytes);
							statusCode = Number(headerText.match(HTTP_STATUS_RE)?.[1] ?? 0) || null;

							let responseBodyBytes;
							if (splitIndex < 0) {
								responseBodyBytes = rawResponse;
							} else if (CHUNKED_TRANSFER_RE.test(`\r\n${headerText}\r\n`)) {
								const decodedChunks = [];
								for (let offset = 0; offset < bodyBytes.length;) {
									const lineEnd = indexOfBytes(bodyBytes, CRLF, offset);
									if (lineEnd < 0) throw new Error('missing chunk size line terminator');
									const sizeHex = dec.decode(bodyBytes.slice(offset, lineEnd)).split(';', 1)[0].trim();
									const size = Number.parseInt(sizeHex, 16);
									if (!Number.isFinite(size)) throw new Error(`invalid chunk size: ${sizeHex}`);
									const bodyStart = lineEnd + CRLF.length;
									const bodyEnd = bodyStart + size;
									if (!size) break;
									if (bodyEnd + CRLF.length > bodyBytes.length) throw new Error('truncated chunk body');
									decodedChunks.push(bodyBytes.slice(bodyStart, bodyEnd));
									offset = bodyEnd + CRLF.length;
								}
								responseBodyBytes = concatBytes(decodedChunks);
							} else {
								responseBodyBytes = bodyBytes;
							}
							const responseText = dec.decode(responseBodyBytes);

							if (statusCode !== 200) {
								const bodyPreview = responseText ? ` body: ${responseText.slice(0, 120)}` : '';
								return buildResult(false, statusCode, `unexpected status: ${statusCode ?? 'unknown'}${bodyPreview}`);
							}

							let payload;
							try {
								payload = JSON.parse(responseText);
							} catch (error) {
								return buildResult(false, statusCode, `invalid json response: ${String(error?.message || error)}`);
							}

							if (!pickExitIp(payload)) return buildResult(false, statusCode, 'probe json missing exit ip');
							return buildResult(true, statusCode, null, { exit: payload });
						} catch (error) {
							return buildResult(false, statusCode, String(error?.message || error));
						} finally {
							try { tlsClient?.close(); } catch { }
							try { if (!tlsClient) socket?.close(); } catch { }
						}
					})
				);

				// probeResults 顺序与 PROBE_TARGETS 一致：[0] => ipv4 探针结果, [1] => ipv6 探针结果
				const [ipv4, ipv6] = probeResults;
				const hasIPv4 = getExitFamily(ipv4) === 'ipv4';
				const hasIPv6 = getExitFamily(ipv6) === 'ipv6';
				// probe_results 展示规则：
				// - 默认：supports_ipv4/supports_ipv6 为 true 才展示对应探针结果
				// - 兜底：当两者都为 false 时，同时展示 ipv4/ipv6 探针结果，便于排错
				const displayedProbeResults = {};
				if (!hasIPv4 && !hasIPv6) {
					if (ipv4) displayedProbeResults.ipv4 = ipv4;
					if (ipv6) displayedProbeResults.ipv6 = ipv6;
				} else {
					if (hasIPv4 && ipv4) displayedProbeResults.ipv4 = ipv4;
					if (hasIPv6 && ipv6) displayedProbeResults.ipv6 = ipv6;
				}
				const inferredStack = hasIPv4 && hasIPv6 ? 'dual_stack' : hasIPv4 ? 'ipv4_only' : hasIPv6 ? 'ipv6_only' : 'unknown';
				const responseTime = probeResults.length
					? Math.ceil(probeResults.reduce((s, r) => s + (Number.isFinite(r?.connect_ms) ? r.connect_ms : 0), 0) / probeResults.length)
					: 0;

				return {
					candidate: rawCandidate,
					success: probeResults.some((result) => result.ok),
					proxyIP: candidate.hostname,
					portRemote: candidate.port,
					inferred_stack: inferredStack,
					supports_ipv4: hasIPv4,
					supports_ipv6: hasIPv6,
					dual_stack: inferredStack === 'dual_stack',
					responseTime,
					colo: req.cf?.colo || 'CF',
					timeStamp: new Date().toISOString(),
					probe_results: displayedProbeResults,
				};
			})
		);
		return checkJsonResponse(results.length === 1 ? results[0] : results);
	} catch (error) {
		return checkJsonResponse({ ok: false, error: String(error?.message || error) }, 500);
	}
}
