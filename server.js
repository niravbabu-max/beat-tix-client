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

function parseCharges(html) {
  const charges = [];
  const seen = new Set();

  // Pattern 1: statute in table cells — e.g. "21-801.1" or "TR21-801"
  const cellRegex = /(\d{2}-\d{3,4}(?:\.\d+)?(?:\([a-zA-Z0-9]\))?)/g;
  const text = stripHtml(html);

  // Pattern 2: look for charge rows in the raw HTML before stripping
  // Maryland Case Search charge rows: statute code + description in adjacent cells
  const tableRowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = tableRowRegex.exec(html)) !== null) {
    const rowText = stripHtml(rowMatch[0]);
    // Look for statute pattern in this row
    const statuteMatch = rowText.match(/(\d{2}-\d{3,4}(?:\.\d+)?(?:\([a-zA-Z0-9]\))?)/);
    if (statuteMatch) {
      const statute = statuteMatch[1];
      // Extract description from the row (everything after the statute that looks like a description)
      const afterStatute = rowText.substring(rowText.indexOf(statute) + statute.length).trim();
      const desc = afterStatute.replace(/^[\s\W]+/, '').substring(0, 120).trim();
      if (!seen.has(statute)) {
        seen.add(statute);
        charges.push({ statute, description: desc });
      }
    }
  }

  // Fallback: just find all statute numbers in the full text
  if (charges.length === 0) {
    let m;
    while ((m = cellRegex.exec(text)) !== null) {
      const statute = m[1];
      if (!seen.has(statute) && !statute.startsWith('00-') && !statute.startsWith('19-')) {
        // Skip obvious non-traffic statutes (19- is MD Rules)
        seen.add(statute);
        charges.push({ statute, description: '' });
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

  try {
    const jar = new Map();

    // ── Step 1: Load disclaimer page ──────────────────────────────────────────
    console.log('[casesearch] Step 1: disclaimer page');
    const s1 = await sfGet(apiKey, `${CASE_SEARCH_BASE}/`, BROWSER_HEADERS);
    mergeCookies(jar, s1?.result?.cookies);

    // ── Step 2: Accept disclaimer ─────────────────────────────────────────────
    console.log('[casesearch] Step 2: accept disclaimer');
    const s2 = await sfPost(
      apiKey,
      `${CASE_SEARCH_BASE}/processDisclaimer.jis`,
      'disclaimer=Y&action=Continue',
      {
        ...BROWSER_HEADERS,
        Cookie: cookieStr(jar),
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${CASE_SEARCH_BASE}/`,
      }
    );
    mergeCookies(jar, s2?.result?.cookies);

    // ── Step 3: Search by case number ─────────────────────────────────────────
    console.log('[casesearch] Step 3: search for', raw);
    const searchBody = new URLSearchParams({
      lastName: '', middleName: '', firstName: '', suffix: '', DOB: '',
      address: '', city: '', state: '', zip: '',
      court: '00', caseType: 'TR', status: 'A',
      filingStart: '', filingEnd: '', nextStart: '0',
      courtSystem: 'B', action: 'Search',
      caseId: raw,
    });

    const s3 = await sfPost(
      apiKey,
      `${CASE_SEARCH_BASE}/inquirySearch.jis`,
      searchBody.toString(),
      {
        ...BROWSER_HEADERS,
        Cookie: cookieStr(jar),
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${CASE_SEARCH_BASE}/inquirySearch.jis`,
      }
    );
    mergeCookies(jar, s3?.result?.cookies);
    let html = s3?.result?.content || '';
    console.log('[casesearch] Step 3 html len:', html.length);

    if (html.length < 500 || html.toLowerCase().includes('no cases found') || html.toLowerCase().includes('no records found')) {
      return res.json({ found: false, error: 'No case found for that number. Try entering your charge manually below.' });
    }

    // ── Step 4: If results list, click into the first case ───────────────────
    const detailLinkMatch = html.match(/href="([^"]*inquiryDetail\.jis[^"]*)/i);
    if (detailLinkMatch) {
      let detailUrl = detailLinkMatch[1].replace(/&amp;/g, '&');
      if (!detailUrl.startsWith('http')) {
        detailUrl = `https://casesearch.courts.state.md.us${detailUrl.startsWith('/') ? '' : '/casesearch/'}${detailUrl}`;
      }
      console.log('[casesearch] Step 4: case detail', detailUrl);
      const s4 = await sfGet(apiKey, detailUrl, {
        ...BROWSER_HEADERS,
        Cookie: cookieStr(jar),
        Referer: `${CASE_SEARCH_BASE}/inquirySearch.jis`,
      });
      if (s4?.result?.content && s4.result.content.length > 500) {
        html = s4.result.content;
      }
    }

    // ── Parse results ─────────────────────────────────────────────────────────
    const charges = parseCharges(html);
    const courtDate = parseCourtDate(html);
    const county = parseCounty(html);

    console.log('[casesearch] charges:', charges.length, '| courtDate:', courtDate, '| county:', county);

    if (charges.length === 0) {
      return res.json({
        found: false,
        error: "Found your case but couldn't read the charges. Please enter your charge manually.",
      });
    }

    return res.json({ found: true, charges, courtDate, county });

  } catch (err) {
    console.error('[casesearch] Error:', err.message);
    return res.json({ found: false, error: 'Lookup failed. Please enter your charge manually below.' });
  }
});

// ── Fallback: serve index.html for all other routes ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Beat-Tix client running on port ${PORT}`));
