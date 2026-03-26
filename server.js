const express = require('express');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static('public'));

// ─── Supabase setup ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asuhkamvyfvtxeqyqdei.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_iRpJb4YxWsFTFgVt_drNaA_7AIuZ1cQ';

// Server-side client (for public reads)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Create an authenticated client from a user's token
function getAuthClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

// Auth middleware — extracts user from Authorization header
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = authHeader.split(' ')[1];
  const client = getAuthClient(token);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  req.user = user;
  req.authClient = client;
  next();
}

// ─── Feed fetching ──────────────────────────────────────────────────────────

function parseSubstackUrl(input) {
  let clean = input.trim().toLowerCase();
  if (!clean.includes('.') && !clean.includes('/')) return clean;
  clean = clean.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const substackMatch = clean.match(/^([a-z0-9_-]+)\.substack\.com/);
  if (substackMatch) return substackMatch[1];
  return clean.split('/')[0];
}

// Discover the Substack subdomain from a custom domain
async function discoverSubstackSubdomain(customDomain) {
  try {
    // Try fetching the custom domain's homepage and look for Substack references
    const res = await fetch(`https://${customDomain}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
      redirect: 'manual'
    });
    // Check if it redirects to a .substack.com URL
    const location = res.headers.get('location') || '';
    const match = location.match(/([a-z0-9_-]+)\.substack\.com/);
    if (match) return match[1];

    // Try the publication API on the custom domain to get the subdomain
    const pubRes = await fetch(`https://${customDomain}/api/v1/publication`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' }
    });
    if (pubRes.ok) {
      const meta = await pubRes.json();
      if (meta.subdomain) return meta.subdomain;
    }
  } catch (e) {}
  return null;
}

async function fetchViaAPI(publication) {
  const isCustomDomain = publication.includes('.');

  // Build list of base URLs to try
  const baseUrls = [];
  if (isCustomDomain) {
    baseUrls.push(`https://${publication}`);
    // Try to discover the Substack subdomain
    const subdomain = await discoverSubstackSubdomain(publication);
    if (subdomain) {
      baseUrls.push(`https://${subdomain}.substack.com`);
      console.log(`Discovered subdomain: ${subdomain} for ${publication}`);
    }
  } else {
    baseUrls.push(`https://${publication}.substack.com`);
  }

  let lastError;
  for (const baseUrl of baseUrls) {
    try {
      console.log(`Trying API at: ${baseUrl}/api/v1/archive`);
      let allPosts = [];
      let offset = 0;
      const limit = 12;
      const maxPosts = 500;

      while (offset < maxPosts) {
        const url = `${baseUrl}/api/v1/archive?sort=new&search=&offset=${offset}&limit=${limit}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
          signal: controller.signal,
          redirect: 'follow'
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          console.log(`API returned ${res.status} at ${url}`);
          throw new Error(`API returned ${res.status}`);
        }

        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          console.log(`API returned non-JSON at ${url}`);
          throw new Error('Non-JSON response');
        }

        if (!Array.isArray(data) || data.length === 0) break;

        console.log(`Got ${data.length} posts at offset ${offset} from ${baseUrl}`);

        // Use the custom domain for post links if available
        const linkBase = isCustomDomain ? `https://${publication}` : baseUrl;

        for (const post of data) {
          const title = post.title || '';
          const slug = post.slug || '';
          const link = `${linkBase}/p/${slug}`;
          const img = post.cover_image || '';
          const postType = post.type || 'newsletter';
          const isArticle = (postType === 'newsletter' || postType === 'thread');
          if (title && slug) {
            const utmLink = `${link}?utm_source=stackpub&utm_medium=portfolio&utm_campaign=grid`;
            allPosts.push({ title, link: utmLink, img, isArticle });
          }
        }
        if (data.length < limit) break;
        offset += limit;
      }

      if (allPosts.length === 0) continue;

      console.log(`Total posts fetched via API: ${allPosts.length}`);

      let name = publication;
      let logo = '';
      let substackUrl = isCustomDomain ? `https://${publication}` : baseUrl;
      try {
        const metaRes = await fetch(`${baseUrl}/api/v1/publication`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' }
        });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          name = meta.name || publication;
          logo = meta.logo_url || meta.logo_url_small || '';
          if (meta.custom_domain) substackUrl = `https://${meta.custom_domain}`;
        }
      } catch (e) {}
      return { name, logo, substackUrl, posts: allPosts };
    } catch (e) {
      console.log(`API failed for ${baseUrl}: ${e.message}`);
      lastError = e;
    }
  }
  throw lastError || new Error('API not available');
}

async function fetchViaRSS(publication) {
  console.log(`Falling back to RSS for ${publication} (limited to ~20 posts)`);
  const isCustomDomain = publication.includes('.');
  const urls = isCustomDomain
    ? [`https://${publication}/feed`]
    : [`https://${publication}.substack.com/feed`];
  let lastError;
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
        redirect: 'follow',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`Could not fetch feed`);
      const xml = await res.text();
      if (!xml.includes('<rss')) throw new Error('Invalid RSS');
      const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
      const channel = parsed.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
      const posts = items.map(item => {
        const title = item.title || '';
        const link = item.link || '';
        let img = '';
        let isArticle = true;
        if (item.enclosure && item.enclosure.$ && item.enclosure.$.type) {
          const mt = item.enclosure.$.type;
          if (mt.startsWith('video/') || mt.startsWith('audio/')) isArticle = false;
        }
        if (item.enclosure && item.enclosure.$ && item.enclosure.$.url) {
          const mt = item.enclosure.$.type || '';
          if (mt.startsWith('image/') || (!mt && item.enclosure.$.url.match(/\.(jpg|jpeg|png|webp|gif)/i))) {
            img = item.enclosure.$.url;
          }
        }
        if (!img) {
          const content = item['content:encoded'] || '';
          const match = content.match(/<img[^>]+src=["']([^"']+)["']/);
          if (match) img = match[1];
        }
        const utmLink = link.includes('?')
          ? `${link}&utm_source=stackpub&utm_medium=portfolio&utm_campaign=grid`
          : `${link}?utm_source=stackpub&utm_medium=portfolio&utm_campaign=grid`;
        return { title, link: utmLink, img, isArticle };
      }).filter(p => p.title && p.link);
      console.log(`RSS returned ${posts.length} posts for ${publication}`);
      const name = channel.title || publication;
      const logo = channel.image?.url || '';
      const substackUrl = channel.link || `https://${publication}${isCustomDomain ? '' : '.substack.com'}`;
      return { name, logo, substackUrl, posts };
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error(`Could not fetch feed`);
}

async function fetchSubstackFeed(publication) {
  try {
    const result = await fetchViaAPI(publication);
    if (result.posts.length > 0) return result;
  } catch (e) {
    console.log(`API route failed entirely for ${publication}, trying RSS`);
  }
  return await fetchViaRSS(publication);
}

// ─── API Routes ──────────────────────────────────────────────────────────────

// Check if a slug is available
app.get('/api/check-slug/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const { data } = await supabase.from('pages').select('slug').eq('slug', slug).single();
  res.json({ available: !data, slug });
});

// Preview a publication (before claiming)
app.post('/api/preview', async (req, res) => {
  const { publicationUrl } = req.body;
  if (!publicationUrl) return res.status(400).json({ error: 'Publication URL required' });
  const publication = parseSubstackUrl(publicationUrl);
  if (!publication) return res.status(400).json({ error: 'Could not parse URL' });
  try {
    const feed = await fetchSubstackFeed(publication);
    res.json({
      name: feed.name,
      logo: feed.logo,
      postCount: feed.posts.length,
      publication
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Claim a page (requires auth)
app.post('/api/claim', requireAuth, async (req, res) => {
  const { publicationUrl, slug, displayName, textStyle } = req.body;
  if (!publicationUrl || !slug || !displayName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (cleanSlug.length < 2 || cleanSlug.length > 40) {
    return res.status(400).json({ error: 'Slug must be 2-40 characters' });
  }

  // Check if user already has a page
  const { data: existing } = await req.authClient.from('pages')
    .select('id').eq('user_id', req.user.id).single();
  if (existing) {
    return res.status(400).json({ error: 'You already have a page. Use the edit page to make changes.' });
  }

  // Check slug availability
  const { data: taken } = await supabase.from('pages')
    .select('slug').eq('slug', cleanSlug).single();
  if (taken) {
    return res.status(400).json({ error: `stack.pub/${cleanSlug} is already taken` });
  }

  const publication = parseSubstackUrl(publicationUrl);

  // Fetch publication meta for logo
  let logo = '';
  try {
    const feed = await fetchSubstackFeed(publication);
    logo = feed.logo || '';
  } catch (e) {}

  const { data, error } = await req.authClient.from('pages').insert({
    user_id: req.user.id,
    slug: cleanSlug,
    publication_url: publicationUrl,
    display_name: displayName,
    logo_url: logo,
    text_style: textStyle || 'broadsheet',
    image_filter: 'none',
    color_overlay: 'none',
    exclude_no_image: true
  }).select().single();

  if (error) {
    return res.status(400).json({ error: error.message });
  }
  res.json({ ok: true, slug: cleanSlug, url: `/${cleanSlug}` });
});

// Update page settings (requires auth)
app.put('/api/page', requireAuth, async (req, res) => {
  const { displayName, textStyle, imageFilter, colorOverlay, logoUrl, excludeNoImage } = req.body;
  const updates = {};
  if (displayName !== undefined) updates.display_name = displayName;
  if (textStyle !== undefined) updates.text_style = textStyle;
  if (imageFilter !== undefined) updates.image_filter = imageFilter;
  if (colorOverlay !== undefined) updates.color_overlay = colorOverlay;
  if (logoUrl !== undefined) updates.logo_url = logoUrl;
  if (excludeNoImage !== undefined) updates.exclude_no_image = excludeNoImage;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await req.authClient.from('pages')
    .update(updates)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, page: data });
});

// Get current user's page (requires auth)
app.get('/api/my-page', requireAuth, async (req, res) => {
  const { data, error } = await req.authClient.from('pages')
    .select('*')
    .eq('user_id', req.user.id)
    .single();
  if (error || !data) return res.json({ page: null });
  res.json({ page: data });
});

// Upload logo (requires auth)
app.post('/api/upload-logo', requireAuth, async (req, res) => {
  // We'll handle this with base64 upload from the client
  const { imageData, fileName } = req.body;
  if (!imageData || !fileName) return res.status(400).json({ error: 'No image provided' });

  // Check file size (base64 is ~33% larger than binary)
  if (imageData.length > 1.4 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image must be under 1MB' });
  }

  const ext = fileName.split('.').pop().toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) {
    return res.status(400).json({ error: 'Invalid image format' });
  }

  const storagePath = `logos/${req.user.id}.${ext}`;
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const { data, error } = await req.authClient.storage
    .from('logos')
    .upload(storagePath, buffer, {
      contentType: `image/${ext === 'svg' ? 'svg+xml' : ext}`,
      upsert: true
    });

  if (error) return res.status(400).json({ error: error.message });

  const { data: urlData } = supabase.storage.from('logos').getPublicUrl(storagePath);
  const logoUrl = urlData.publicUrl;

  // Update the page with the new logo
  await req.authClient.from('pages')
    .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
    .eq('user_id', req.user.id);

  res.json({ ok: true, logoUrl });
});

// Debug endpoint — test feed fetching
app.get('/api/debug-feed/:publication', async (req, res) => {
  const publication = req.params.publication;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); origLog(...args); };
  try {
    const feed = await fetchSubstackFeed(publication);
    console.log = origLog;
    res.json({
      success: true,
      postCount: feed.posts.length,
      name: feed.name,
      logo: feed.logo ? 'yes' : 'no',
      sampleTitles: feed.posts.slice(0, 3).map(p => p.title),
      lastTitles: feed.posts.slice(-3).map(p => p.title),
      logs
    });
  } catch (e) {
    console.log = origLog;
    res.json({ success: false, error: e.message, logs });
  }
});

// Debug: test RSS pagination specifically
app.get('/api/debug-rss/:publication', async (req, res) => {
  const publication = req.params.publication;
  const isCustomDomain = publication.includes('.');
  const baseUrl = isCustomDomain
    ? `https://${publication}/feed`
    : `https://${publication}.substack.com/feed`;

  const results = [];
  let allLinks = new Set();
  let totalNew = 0;

  for (let page = 1; page <= 10; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
        redirect: 'follow',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!r.ok) { results.push({ page, status: r.status, items: 0 }); break; }
      const xml = await r.text();
      if (!xml.includes('<rss')) { results.push({ page, error: 'not RSS', items: 0 }); break; }
      const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
      const channel = parsed.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

      let newOnPage = 0;
      for (const item of items) {
        const link = item.link || '';
        if (link && !allLinks.has(link)) {
          allLinks.add(link);
          newOnPage++;
          totalNew++;
        }
      }
      results.push({ page, itemsOnPage: items.length, newItems: newOnPage, totalSoFar: totalNew });
      if (newOnPage === 0) break;
    } catch (e) {
      results.push({ page, error: e.message });
      break;
    }
  }

  res.json({ totalUniquePosts: totalNew, pages: results });
});

// ─── Static pages ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));

// ─── Posts API (for client-side loading) ─────────────────────────────────────
app.get('/api/posts/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const { data: page } = await supabase.from('pages')
    .select('*').eq('slug', slug).single();
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const publication = parseSubstackUrl(page.publication_url);
  try {
    const feed = await fetchSubstackFeed(publication);
    let posts = feed.posts;
    if (page.exclude_no_image) posts = posts.filter(p => p.img && p.isArticle !== false);
    res.json({
      posts,
      substackUrl: feed.substackUrl || page.publication_url,
      logo: page.logo_url || feed.logo || '',
      postCount: posts.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Public portfolio page (instant shell, posts load client-side) ───────────
app.get('/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  if (['api', 'login', 'dashboard', 'favicon.ico'].includes(slug)) return res.status(404).end();

  const { data: page, error } = await supabase.from('pages')
    .select('*').eq('slug', slug).single();

  if (!page) return res.status(404).send(notFoundHTML(slug));

  // Serve the page shell instantly — posts load via JS
  res.send(renderPageShell({
    slug: page.slug,
    displayName: page.display_name,
    logoUrl: page.logo_url || '',
    textStyle: page.text_style || 'broadsheet',
    imageFilter: page.image_filter || 'none',
    colorOverlay: page.color_overlay || 'none',
    publicationUrl: page.publication_url
  }));
});

// ─── Portfolio page renderer (composable styles) ─────────────────────────────
const textStyleFonts = {
  broadsheet: {
    import: "family=Sora:wght@500;600&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Sora', sans-serif", body: "'DM Sans', sans-serif"
  },
  byline: {
    import: "family=Newsreader:ital,wght@1,400;1,500&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Newsreader', serif", body: "'DM Sans', sans-serif"
  },
  billboard: {
    import: "family=Bebas+Neue&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Bebas Neue', sans-serif", body: "'DM Sans', sans-serif"
  },
  handwritten: {
    import: "family=Caveat:wght@500;700&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Caveat', cursive", body: "'DM Sans', sans-serif"
  }
};

function getTextStyleCSS(textStyle, fonts) {
  const styles = {
    broadsheet: `
      .card .overlay {
        display: flex; align-items: flex-start; text-align: left; padding: 7cqi;
        background: linear-gradient(to bottom, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.35) 25%, rgba(0,0,0,0.12) 50%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 600; font-size: 8.5cqi;
        color: #fff; line-height: 1.1; letter-spacing: -0.01em;
        text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 2px 10px rgba(0,0,0,0.5), 0 0 24px rgba(0,0,0,0.3);
        display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
      }`,
    byline: `
      .card .overlay {
        display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
        text-align: center; padding: 7cqi;
        background: linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.35) 25%, rgba(0,0,0,0.12) 50%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400; font-size: 12cqi;
        font-style: italic; color: #fff; line-height: 1.1;
        text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 2px 10px rgba(0,0,0,0.5), 0 0 24px rgba(0,0,0,0.3);
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
      }`,
    billboard: `
      .card .overlay {
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 6cqi; background: rgba(0,0,0,0.18);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400; font-size: 14cqi;
        color: rgba(255,255,255,0.75); text-transform: uppercase; line-height: 0.92; letter-spacing: 0.03em;
        text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 28px rgba(0,0,0,0.35);
        display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
      }`,
    handwritten: `
      .card .overlay {
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 7cqi; background: rgba(0,0,0,0.15);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 700; font-size: 14cqi;
        color: #fff; line-height: 1.15; letter-spacing: 0.01em;
        text-shadow: 0 2px 6px rgba(0,0,0,0.7), 0 0 20px rgba(0,0,0,0.4);
        display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
      }`
  };
  return styles[textStyle] || styles.broadsheet;
}

function getFilterCSS(imageFilter) {
  const filters = {
    none: '',
    vintage: `
      .card img { filter: brightness(0.75) saturate(0.5) sepia(0.4) contrast(1.1); }
      .card:hover img, .card:active img { filter: brightness(0.9) saturate(0.6) sepia(0.3) contrast(1.05); transform: scale(1.03); }`,
    pop: `
      .card img { filter: brightness(0.8) saturate(1.6) contrast(1.15); }
      .card:hover img, .card:active img { filter: brightness(0.95) saturate(1.8) contrast(1.1); transform: scale(1.03); }`,
    noir: `
      .card img { filter: brightness(0.7) saturate(0) contrast(1.3); }
      .card:hover img, .card:active img { filter: brightness(0.9) saturate(0) contrast(1.2); transform: scale(1.03); }`
  };
  return filters[imageFilter] || '';
}

function getOverlayCSS(colorOverlay) {
  const overlays = {
    none: '',
    rose: `
      .card::after { content:''; position:absolute; inset:0; z-index:1; background:rgba(180,60,100,0.35); transition:opacity 0.5s ease; pointer-events:none; }
      .card:hover::after, .card:active::after { opacity:0; }
      .card .overlay { z-index:2; }`,
    ocean: `
      .card::after { content:''; position:absolute; inset:0; z-index:1; background:rgba(20,60,120,0.4); transition:opacity 0.5s ease; pointer-events:none; }
      .card:hover::after, .card:active::after { opacity:0; }
      .card .overlay { z-index:2; }`,
    gold: `
      .card::after { content:''; position:absolute; inset:0; z-index:1; background:rgba(160,110,20,0.35); transition:opacity 0.5s ease; pointer-events:none; }
      .card:hover::after, .card:active::after { opacity:0; }
      .card .overlay { z-index:2; }`
  };
  return overlays[colorOverlay] || '';
}

function renderPageShell({ slug, displayName, logoUrl, textStyle, imageFilter, colorOverlay, publicationUrl }) {
  let header;
  if (logoUrl) {
    header = `<img class="logo" src="${esc(logoUrl)}" alt="${esc(displayName)}" />\n    <div class="site-name sub">${esc(displayName)}</div>`;
  } else {
    header = `<div class="site-name">${esc(displayName)}</div>`;
  }

  const ts = textStyle || 'broadsheet';
  const fonts = textStyleFonts[ts] || textStyleFonts.broadsheet;
  const textCSS = getTextStyleCSS(ts, fonts);
  const filterCSS = getFilterCSS(imageFilter || 'none');
  const overlayCSS = getOverlayCSS(colorOverlay || 'none');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(displayName)}</title>
  <meta property="og:title" content="${esc(displayName)}" />
  <meta property="og:description" content="Stories by ${esc(displayName)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?${fonts.import}&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; font-family: ${fonts.body}; min-height: 100vh; -webkit-font-smoothing: antialiased; }
    header { display: flex; flex-direction: column; align-items: center; padding: 44px 24px 22px; gap: 10px; }
    .logo { width: clamp(160px, 42vw, 280px); height: auto; display: block; }
    .site-name { font-weight: 700; font-size: clamp(24px, 5vw, 36px); letter-spacing: -0.02em; color: #1a1a1a; text-align: center; }
    .site-name.sub { font-size: clamp(14px, 3vw, 18px); font-weight: 400; color: #888; letter-spacing: 0.02em; margin-top: -4px; }
    .subscribe-btn { display: inline-block; padding: 11px 30px; margin-top: 6px; background: #1a1a1a; color: #fff; font-family: ${fonts.body}; font-weight: 600; font-size: 14px; text-decoration: none; border-radius: 6px; transition: background 0.2s; }
    .subscribe-btn:hover { background: #333; }
    .instruction { font-weight: 300; font-size: 13px; color: #ccc; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; margin-top: 10px; max-width: 935px; margin-left: auto; margin-right: auto; }
    .card { position: relative; aspect-ratio: 3/4; overflow: hidden; display: block; text-decoration: none; background: #1a1a1a; container-type: inline-size; }
    .card img { width: 100%; height: 100%; object-fit: cover; display: block; filter: brightness(0.7) saturate(0.9); transition: filter 0.4s ease, transform 0.5s ease; }
    .card:hover img, .card:active img { filter: brightness(0.95) saturate(1.1); transform: scale(1.03); }
    .overlay { position: absolute; inset: 0; pointer-events: none; }
    ${textCSS}
    ${filterCSS}
    ${overlayCSS}
    .loading-wrap { display: flex; flex-direction: column; align-items: center; padding: 60px 24px; gap: 16px; }
    .loader { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; width: 52px; }
    .loader span { width: 16px; height: 16px; border-radius: 3px; background: #e0e0e0; animation: pulse 1.2s ease-in-out infinite; }
    .loader span:nth-child(2) { animation-delay: 0.1s; } .loader span:nth-child(3) { animation-delay: 0.2s; }
    .loader span:nth-child(4) { animation-delay: 0.1s; } .loader span:nth-child(5) { animation-delay: 0.2s; }
    .loader span:nth-child(6) { animation-delay: 0.3s; } .loader span:nth-child(7) { animation-delay: 0.2s; }
    .loader span:nth-child(8) { animation-delay: 0.3s; } .loader span:nth-child(9) { animation-delay: 0.4s; }
    @keyframes pulse { 0%, 100% { background: #e8e8e8; } 50% { background: #ccc; } }
    .loading-text { font-size: 13px; color: #bbb; }
    .card { opacity: 0; animation: cardIn 0.3s ease forwards; }
    @keyframes cardIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
    footer { text-align: center; padding: 36px 24px; font-size: 11px; color: #ccc; letter-spacing: 0.04em; }
    footer a { color: #ccc; text-decoration: none; } footer a:hover { color: #999; }
  </style>
</head>
<body>
  <header>
    ${header}
    <a class="subscribe-btn" id="subscribeBtn" href="#" target="_blank" rel="noopener">Subscribe</a>
    <p class="instruction">Tap a story to read</p>
  </header>
  <div class="loading-wrap" id="loading">
    <div class="loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    <p class="loading-text">Loading stories...</p>
  </div>
  <main class="grid" id="grid"></main>
  <footer id="footer" style="display:none;">
    Powered by <a href="/">stack.pub</a> &middot; <span id="postCount">0</span> stories
  </footer>
  <script>
    const slug = '${esc(slug)}';
    async function loadPosts() {
      try {
        const res = await fetch('/api/posts/' + slug);
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        if (data.substackUrl) document.getElementById('subscribeBtn').href = data.substackUrl + '/subscribe';
        const grid = document.getElementById('grid');
        data.posts.forEach((p, i) => {
          const card = document.createElement('a');
          card.className = 'card'; card.href = p.link; card.target = '_blank'; card.rel = 'noopener';
          card.style.animationDelay = (i * 0.03) + 's';
          if (p.img) { const img = document.createElement('img'); img.src = p.img; img.alt = ''; img.loading = 'lazy'; img.onerror = function(){this.style.display='none'}; card.appendChild(img); }
          const ov = document.createElement('div'); ov.className = 'overlay';
          ov.innerHTML = '<span class="card-title">' + escHTML(p.title) + '</span>';
          card.appendChild(ov); grid.appendChild(card);
        });
        document.getElementById('postCount').textContent = data.posts.length;
        document.getElementById('footer').style.display = 'block';
        document.getElementById('loading').style.display = 'none';
      } catch (e) { document.getElementById('loading').innerHTML = '<p class="loading-text">Could not load stories. Please try again.</p>'; }
    }
    function escHTML(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    loadPosts();
  </script>
</body>
</html>`;
}

function notFoundHTML(slug) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600&display=swap" rel="stylesheet" />
  <style>body{font-family:'DM Sans',sans-serif;text-align:center;padding:4rem;color:#1a1a1a}h2{font-size:28px;font-weight:700;margin-bottom:8px}p{font-size:15px;color:#666;margin-top:8px}a{color:#1a1a1a;font-weight:600}</style>
  </head><body>
  <h2>Page not found</h2>
  <p>No portfolio found for <strong>${slug}</strong>.</p>
  <p><a href="/">Create one at stack.pub</a></p>
  </body></html>`;
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`stack.pub running on http://localhost:${PORT}`));
