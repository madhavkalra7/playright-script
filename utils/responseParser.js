/**
 * Response Parser Utility
 * Parses ChatGPT's Server-Sent Events (SSE) stream body
 * and extracts result_source, citations, and the full response text.
 *
 * ChatGPT now uses v1 delta_encoding for streaming responses.
 * Event chunks contain JSON-Patch operations to update a central document state.
 */

/**
 * Parse raw SSE body text into an array of JSON chunk objects.
 * @param {string} rawText - Full SSE response body as UTF-8 string
 * @returns {Object[]} - Array of parsed JSON objects
 */
function parseSSEBody(rawText) {
  const lines = rawText.split('\n');
  const chunks = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, and the DONE sentinel
    if (!trimmed || !trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') {
      continue;
    }

    try {
      const json = JSON.parse(trimmed.slice(6)); // Remove "data: " prefix
      chunks.push(json);
    } catch (_e) {
      // Ignore malformed / partial JSON lines
    }
  }

  return chunks;
}

/**
 * Recursively search an object tree for all `result_source` fields.
 * Known values: "oxylabs", "labrador", "bright", "serp", "bing", etc.
 *
 * @param {*} obj
 * @param {string[]} found - accumulator
 * @returns {string[]}
 */
function findAllResultSources(obj, found = []) {
  if (!obj || typeof obj !== 'object') return found;

  // Direct key hit
  if (Object.prototype.hasOwnProperty.call(obj, 'result_source') && obj.result_source) {
    found.push(String(obj.result_source));
  }

  // Recurse into arrays and objects
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const val of values) {
    if (val && typeof val === 'object') {
      findAllResultSources(val, found);
    }
  }

  return found;
}

/**
 * Extract domain from a URL string.
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_e) {
    return '';
  }
}

/**
 * Set value inside an object at a JSON Pointer path (e.g. "/message/content/parts/0")
 */
function setValueAtPath(obj, pathStr, val, op) {
  if (!pathStr) {
    if (typeof val === 'object' && val !== null) {
      Object.assign(obj, val);
    }
    return;
  }
  
  const parts = pathStr.split('/').filter(p => p !== '');
  let current = obj;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const key = Array.isArray(current) ? parseInt(part, 10) : part;

    if (isLast) {
      if (op === 'append') {
        if (typeof val === 'string') {
          current[key] = (current[key] || '') + val;
        } else if (Array.isArray(val)) {
          current[key] = (current[key] || []).concat(val);
        } else if (typeof val === 'object' && val !== null) {
          current[key] = Object.assign(current[key] || {}, val);
        } else {
          current[key] = val;
        }
      } else if (op === 'add') {
        if (Array.isArray(current[key])) {
          current[key].push(val);
        } else {
          current[key] = val;
        }
      } else {
        current[key] = val;
      }
    } else {
      if (!(part in current)) {
        const nextPart = parts[i + 1];
        const isNextIndex = /^\d+$/.test(nextPart);
        current[part] = isNextIndex ? [] : {};
      }
      current = current[part];
    }
  }
}

/**
 * Extract all useful data from parsed SSE chunks by reconstructing the message state.
 *
 * @param {Object[]} chunks
 * @returns {{
 *   gptResponse: string,
 *   resultSource: string,
 *   resultSourcesAll: string[],
 *   citations: Object[],
 *   citationsRaw: string,
 *   citationDomains: string,
 *   pubDate: string,
 *   snippetLength: number
 * }}
 */
function extractData(chunks) {
  const state = {};

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;

    // Check if it's a standard patch update containing multiple operations
    if (chunk.o === 'patch' && Array.isArray(chunk.v)) {
      for (const op of chunk.v) {
        setValueAtPath(state, op.p, op.v, op.o);
      }
    }
    // Check if it's a direct path update
    else if (chunk.p && chunk.o) {
      setValueAtPath(state, chunk.p, chunk.v, chunk.o);
    }
    // Check if it is a simple text append (implicit path /message/content/parts/0)
    else if (typeof chunk.v === 'string' && !chunk.p) {
      setValueAtPath(state, '/message/content/parts/0', chunk.v, 'append');
    }
    // If the chunk itself contains value at root but has no explicit operation
    else if (chunk.v && typeof chunk.v === 'object') {
      setValueAtPath(state, chunk.p || '', chunk.v, chunk.o || 'append');
    }
  }

  // Extract response text
  const gptResponse = state?.message?.content?.parts?.[0] || '';

  // Extract result sources
  const allResultSources = findAllResultSources(state);
  const uniqueSources = [...new Set(allResultSources.filter(Boolean))];

  // Extract citations
  const citationsRaw = [];
  
  const addCitation = (item) => {
    if (!item) return;
    const url = item.url || item.source_url || '';
    const title = item.title || '';
    const snippet = item.text || item.snippet || '';
    const pub = item.pub_date || item.published_date || '';
    const source = item.result_source || item.metadata?.result_source || '';

    // De-duplicate by URL
    if (url && !citationsRaw.some(c => c.url === url)) {
      citationsRaw.push({ title, url, snippet, pub_date: pub, result_source: source });
    }
  };

  // 1. Extract from content_references
  const contentRefs = state?.message?.metadata?.content_references || [];
  for (const ref of contentRefs) {
    const items = ref?.items || [];
    for (const item of items) {
      addCitation(item);
    }
  }

  // 2. Extract from search_result_groups
  const searchGroups = state?.message?.metadata?.search_result_groups || [];
  for (const group of searchGroups) {
    const entries = group?.entries || [];
    for (const entry of entries) {
      addCitation(entry);
    }
  }

  // 3. Fallback: extract from direct citations array in metadata
  const metaCitations = state?.message?.metadata?.citations || [];
  for (const cite of metaCitations) {
    addCitation(cite);
  }

  // Format citation domains and calculate frequencies
  const domainSet = new Set();
  let pubDate = '';
  let snippetTotalLength = 0;
  const sourceFrequencies = {};
  
  const brightUrls = [];
  const labradorUrls = [];
  const oxylabsUrls = [];
  const serpUrls = [];
  const bingUrls = [];

  for (const cite of citationsRaw) {
    snippetTotalLength += cite.snippet.length;
    if (!pubDate && cite.pub_date) {
      if (typeof cite.pub_date === 'number') {
        // Convert epoch timestamp to YYYY-MM-DD
        pubDate = new Date(cite.pub_date * 1000).toISOString().slice(0, 10);
      } else {
        pubDate = String(cite.pub_date);
      }
    }
    if (cite.url) {
      const domain = extractDomain(cite.url);
      if (domain) domainSet.add(domain);
    }
    
    // Group citation URLs by result source
    const src = cite.result_source;
    if (src) {
      sourceFrequencies[src] = (sourceFrequencies[src] || 0) + 1;
      
      const cleanSrc = src.toLowerCase().trim();
      const url = cite.url || '';
      if (url) {
        const title = (cite.title || '').trim();
        const citationStr = title ? `${title} (${url})` : url;
        if (cleanSrc === 'bright') brightUrls.push(citationStr);
        else if (cleanSrc === 'labrador') labradorUrls.push(citationStr);
        else if (cleanSrc === 'oxylabs') oxylabsUrls.push(citationStr);
        else if (cleanSrc === 'serp') serpUrls.push(citationStr);
        else if (cleanSrc === 'bing') bingUrls.push(citationStr);
      }
    }
  }

  // If a source was found in recursive search but not counted in citations yet (e.g. general search source)
  for (const src of uniqueSources) {
    if (!sourceFrequencies[src]) {
      sourceFrequencies[src] = 0;
    }
  }

  return {
    gptResponse,
    resultSource: uniqueSources.join('; '),
    resultSourcesAll: uniqueSources,
    resultSourceCount: allResultSources.length,
    resultSourceFrequencies: sourceFrequencies,
    
    // Citation URLs by source
    sourceBrightCitations: brightUrls.join('; '),
    sourceLabradorCitations: labradorUrls.join('; '),
    sourceOxylabsCitations: oxylabsUrls.join('; '),
    sourceSerpCitations: serpUrls.join('; '),
    sourceBingCitations: bingUrls.join('; '),

    citations: citationsRaw,
    citationsRaw: JSON.stringify(citationsRaw),
    citationDomains: [...domainSet].join('; '),
    pubDate,
    snippetLength: snippetTotalLength || ''
  };
}

module.exports = { parseSSEBody, extractData };
