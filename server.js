const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SCRAPFLY_BASE = 'https://api.scrapfly.io/scrape';
const CASE_SEARCH_BASE = 'https://casesearch.courts.state.md.us/casesearch';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
};

// ── Cookie helpers ────────────────────────────────────────────────────────────
function mergeCookies(jar, cookies) {
  for (const c of (cookies || [])) jar.set(c.name, c.value);
}
function cookieStr(jar) {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── ScrapFly GET ──────────────────────────────────────────────────────────────
async function sfGet(apiKey, url, extraHeaders = {}) {
  const params = new URLSearchParams({ key: apiKey, url, country: 'us', asp: 'true' });
  for (const [k, v] of Object.entries(extraHeaders)) params.set(`headers[${k}]`, v);
  const resp = await fetch(`${SCRAPFLY_BASE}?${params}`);
  return resp.json();
}

// ── ScrapFly POST ─────────────────────────────────────────────────────────────
async function sfPost(apiKey, url, body, extraHeaders = {}) {
  const params = new URLSearchParams({ key: apiKey, url, country: 'us', asp: 'true' });
  for (const [k, v] of Object.entries(extraHeaders)) params.set(`headers[${k}]`, v);
  const resp = await fetch(`${SCRAPFLY_BASE}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return resp.json();
}

// ── Maryland counties list ────────────────────────────────────────────────────
const MD_COUNTIES = [
  'Allegany', 'Anne Arundel', 'Baltimore City', 'Baltimore County',
  'Calvert', 'Caroline', 'Carroll', 'Cecil', 'Charles', 'Dorchester',
  'Frederick', 'Garrett', 'Harford', 'Howard', 'Kent', 'Montgomery',
  "Prince George's", "Queen Anne's", 'Somerset', "St. Mary's",
  'Talbot', 'Washington', 'Wicomico', 'Worcester',
];

// ── HTML parsers ──────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Convert Maryland Case Search statute format "TA.21.902.B1.I" → "21-902(b)"
function convertStatute(raw) {
  if (!raw) return null;
  raw = raw.trim();

  // Handle "TA.XX.XXX..." format (standard Maryland Case Search format)
  if (/^TA\./i.test(raw)) {
    const parts = raw.split('.');
    if (parts.length < 3) return null;
    const title = parts[1];
    let section = parts[2];
    let subsection = '';

    if (parts.length >= 4) {
      const p3 = parts[3];
      if (/^\d+$/.test(p3)) {
        // Decimal part of section (e.g. 801.1)
        section = section + '.' + p3;
        if (parts.length >= 5) {
          // Next part is subsection letter (e.g. "A", "B1")
          subsection = parts[4].replace(/\d/g, '').charAt(0).toLowerCase();
        }
      } else {
        // p3 is subsection letter (e.g. "A", "B1", "C")
        subsection = p3.replace(/\d/g, '').charAt(0).toLowerCase();
      }
    }
    const base = `${title}-${section}`;
    return subsection ? `${base}(${subsection})` : base;
  }

  // Already in standard dash format (e.g. "21-801")
  if (/^\d{2}-\d{3}/.test(raw)) return raw;

  return null;
}

function parseCharges(html) {
  const charges = [];
  const seen = new Set();
  const text = stripHtml(html);

  // ── Primary: Maryland Case Search "Statute Code: TA.XX.XXX" format ──────────
  // Pattern: "Statute Code: TA.21.902.B1.I Charge Description: DRIVING VEH..."
  const pairs = text.matchAll(/Statute Code:\s*([\w.]+)\s*Charge Description:\s*([A-Z][A-Z0-9\s\-\/\.\(\)]{2,80}?)(?=\s+[A-Z][a-z]|\s*$)/g);
  for (const m of pairs) {
    const statute = convertStatute(m[1]);
    const desc = m[2].trim();
    if (statute && !seen.has(statute)) {
      seen.add(statute);
      charges.push({ statute, description: desc, rawStatute: m[1] });
    }
  }

  // ── Fallback A: separate Statute Code and Description lines ─────────────────
  if (charges.length === 0) {
    const statutes = [...text.matchAll(/Statute Code:\s*([\w.]+)/g)].map(m => convertStatute(m[1])).filter(Boolean);
    const descs = [...text.matchAll(/Charge Description:\s*([A-Z][A-Z0-9\s\-\/\.]{2,80}?)(?=\s+[A-Z][a-z]|\s*$)/g)].map(m => m[1].trim());
    for (let i = 0; i < statutes.length; i++) {
      if (!seen.has(statutes[i])) {
        seen.add(statutes[i]);
        charges.push({ statute: statutes[i], description: descs[i] || '' });
      }
    }
  }

  // ── Fallback B: look for raw TA. codes anywhere in text ─────────────────────
  if (charges.length === 0) {
    for (const m of text.matchAll(/TA\.(\d{2}\.\d{3,4}[.\w]*)/gi)) {
      const statute = convertStatute('TA.' + m[1]);
      if (statute && !seen.has(statute)) {
        seen.add(statute);
        charges.push({ statute, description: '' });
      }
    }
  }

  // ── Fallback C: plain statute numbers (21-801, 16-303, etc.) ────────────────
  if (charges.length === 0) {
    for (const m of text.matchAll(/(\d{2}-\d{3,4}(?:\.\d+)?(?:\([a-zA-Z0-9]\))?)/g)) {
      const s = m[1];
      if (!seen.has(s) && !s.startsWith('00-') && !s.startsWith('19-')) {
        seen.add(s);
        charges.push({ statute: s, description: '' });
      }
    }
  }

  return charges;
}

function parseCourtDate(html) {
  const text = stripHtml(html);
  // Look for hearing/trial date patterns
  const patterns = [
    /(?:Hearing|Trial|Court)\s+Date[\s:]+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:Next\s+)?(?:Scheduled\s+)?(?:Event|Hearing)[\s\S]{0,40}?(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})[\s\S]{0,30}?(?:Hearing|Trial|Arraignment)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const parts = m[1].split('/');
      if (parts.length === 3) {
        return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
      }
    }
  }
  return null;
}

function parseCounty(html) {
  const text = stripHtml(html);
  for (const county of MD_COUNTIES) {
    if (text.includes(county)) return county;
  }
  return null;
}

function parseDefendant(html) {
  const text = stripHtml(html);
  const m = text.match(/(?:Defendant|Party)\s*:\s*([A-Z][A-Z\s,]+?)(?:\s{2,}|\n|DOB|Address)/i);
  return m ? m[1].trim() : null;
}

// ── Main lookup endpoint ──────────────────────────────────────────────────────
app.post('/api/lookup-citation', async (req, res) => {
  const raw = (req.body.citationNumber || '').trim().toUpperCase().replace(/\s+/g, '');

  if (!raw || raw.length < 4) {
    return res.json({ found: false, error: 'Please enter a valid case or citation number.' });
  }

  const apiKey = process.env.SCRAPFLY_API_KEY;
  if (!apiKey) {
    return res.json({ found: false, error: 'Lookup service not available right now.' });
  }

  const dbg = { steps: [] };

  try {
    const jar = new Map();

    // ── Step 1: Load disclaimer page ──────────────────────────────────────────
    const s1 = await sfGet(apiKey, `${CASE_SEARCH_BASE}/`, BROWSER_HEADERS);
    mergeCookies(jar, s1?.result?.cookies);
    const s1text = stripHtml(s1?.result?.content || '').substring(0, 200);
    dbg.steps.push({ step: 1, len: s1?.result?.content?.length || 0, cookies: jar.size, sample: s1text });

    // ── Step 2: Accept disclaimer ─────────────────────────────────────────────
    const s2 = await sfPost(
      apiKey,
      `${CASE_SEARCH_BASE}/processDisclaimer.jis`,
      'disclaimer=Y&action=Continue',
      { ...BROWSER_HEADERS, Cookie: cookieStr(jar), 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${CASE_SEARCH_BASE}/` }
    );
    mergeCookies(jar, s2?.result?.cookies);
    const s2text = stripHtml(s2?.result?.content || '').substring(0, 200);
    dbg.steps.push({ step: 2, len: s2?.result?.content?.length || 0, cookies: jar.size, sample: s2text });

    // ── Step 3: Search by case number ─────────────────────────────────────────
    const searchBody = new URLSearchParams({
      lastName: '', middleName: '', firstName: '', suffix: '', DOB: '',
      address: '', city: '', state: '', zip: '',
      court: '00', caseType: 'TR', status: 'A',
      filingStart: '', filingEnd: '', nextStart: '0',
      courtSystem: 'B', action: 'Search', caseId: raw,
    });

    const s3 = await sfPost(
      apiKey,
      `${CASE_SEARCH_BASE}/inquirySearch.jis`,
      searchBody.toString(),
      { ...BROWSER_HEADERS, Cookie: cookieStr(jar), 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${CASE_SEARCH_BASE}/inquirySearch.jis` }
    );
    mergeCookies(jar, s3?.result?.cookies);
    let html = s3?.result?.content || '';
    const s3text = stripHtml(html).substring(0, 300);
    dbg.steps.push({ step: 3, len: html.length, cookies: jar.size, hasStatute: html.includes('Statute'), hasCase: html.includes('Case'), sample: s3text });

    if (html.length < 500 || html.toLowerCase().includes('no cases found') || html.toLowerCase().includes('no records found')) {
      return res.json({ found: false, error: 'No case found for that number. Try entering your charge manually below.', _dbg: dbg });
    }

    // ── Step 4: Follow detail link if search returned a list ─────────────────
    const detailLinkMatch = html.match(/href="([^"]*inquiryDetail\.jis[^"]*)/i);
    dbg.steps.push({ step: 4, detailLinkFound: !!detailLinkMatch, link: detailLinkMatch?.[1]?.substring(0, 100) });

    if (detailLinkMatch) {
      let detailUrl = detailLinkMatch[1].replace(/&amp;/g, '&');
      if (!detailUrl.startsWith('http')) {
        detailUrl = `https://casesearch.courts.state.md.us${detailUrl.startsWith('/') ? '' : '/casesearch/'}${detailUrl}`;
      }
      const s4 = await sfGet(apiKey, detailUrl, { ...BROWSER_HEADERS, Cookie: cookieStr(jar), Referer: `${CASE_SEARCH_BASE}/inquirySearch.jis` });
      const s4html = s4?.result?.content || '';
      dbg.steps.push({ step: '4b', len: s4html.length, hasStatute: s4html.includes('Statute'), sample: stripHtml(s4html).substring(0, 300) });
      if (s4html.length > 500) html = s4html;
    }

    // ── Parse results ─────────────────────────────────────────────────────────
    const charges = parseCharges(html);
    const courtDate = parseCourtDate(html);
    const county = parseCounty(html);
    dbg.chargesFound = charges.length;
    dbg.hasStatuteCode = html.includes('Statute Code');
    dbg.finalSample = stripHtml(html).substring(0, 500);

    if (charges.length === 0) {
      return res.json({
        found: false,
        error: "Found your case but couldn't read the charges. Please enter your charge manually.",
        _dbg: dbg,
      });
    }

    return res.json({ found: true, charges, courtDate, county });

  } catch (err) {
    console.error('[casesearch] Error:', err.message);
    dbg.error = err.message;
    return res.json({ found: false, error: 'Lookup failed. Please enter your charge manually below.', _dbg: dbg });
  }
});

// ── Fallback: serve index.html for all other routes ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Beat-Tix client running on port ${PORT}`));
