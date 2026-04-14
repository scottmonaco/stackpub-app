const express = require('express');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ─── Stripe setup ──────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || '';
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || '';
let stripe;
if (STRIPE_SECRET_KEY) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

// Stripe webhook needs raw body — must be before express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send('Stripe not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook error');
  }

  console.log('Stripe event:', event.type);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      if (userId) {
        await supabaseAdmin.from('pages').update({
          is_paid: true,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          updated_at: new Date().toISOString()
        }).eq('user_id', userId);
        console.log('Activated paid for user:', userId);
      }
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const subId = subscription.id;
      const isActive = ['active', 'trialing'].includes(subscription.status);
      const updateData = {
        is_paid: isActive,
        updated_at: new Date().toISOString()
      };
      // If subscription is no longer active, revert PRO-only styles to free defaults
      if (!isActive) {
        updateData.image_filter = 'none';
        updateData.color_overlay = 'none';
      }
      await supabaseAdmin.from('pages').update(updateData).eq('stripe_subscription_id', subId);
      console.log('Subscription', subId, 'status:', subscription.status, '→ is_paid:', isActive);
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      console.log('Payment failed for subscription:', subId);
      // Don't immediately revoke — Stripe retries. Revocation happens on subscription.deleted.
    }
  } catch (e) {
    console.log('Webhook processing error:', e.message);
  }

  res.json({ received: true });
});

// Standard middleware (after webhook route)
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static('public'));

// ─── Supabase setup ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asuhkamvyfvtxeqyqdei.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_iRpJb4YxWsFTFgVt_drNaA_7AIuZ1cQ';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Server-side client (for public reads)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Service role client (bypasses RLS — for webhooks and server-side writes)
const supabaseAdmin = SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : supabase;

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

// Validate publication URL before parsing — catches common user mistakes
function validatePublicationUrl(input) {
  const clean = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

  // Reject bare @ handles
  if (/^@/.test(clean)) {
    return { valid: false, error: 'That looks like a username handle. Your publication URL should be yourname.substack.com or your custom domain.' };
  }

  // Reject substack.com/@username (profile URL)
  if (/^substack\.com\/@/.test(clean)) {
    return { valid: false, error: 'That\'s your Substack profile page. Your publication URL should be yourname.substack.com or your custom domain.' };
  }

  // Reject substack.com/profile/...
  if (/^substack\.com\/profile/.test(clean)) {
    return { valid: false, error: 'That\'s your Substack profile page. Your publication URL should be yourname.substack.com or your custom domain.' };
  }

  // Reject bare substack.com or open.substack.com
  if (/^(open\.)?substack\.com(\/.*)?$/.test(clean) && !/^[a-z0-9_-]+\.substack\.com/.test(clean)) {
    return { valid: false, error: 'That\'s the Substack homepage. Your publication URL should be yourname.substack.com or your custom domain.' };
  }

  // Reject substack.com/home or other substack.com paths that aren't publications
  if (/^substack\.com\/(home|search|discover|inbox|settings|recommendations)/.test(clean)) {
    return { valid: false, error: 'That\'s a Substack page, not a publication. Your publication URL should be yourname.substack.com or your custom domain.' };
  }

  return { valid: true };
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
            allPosts.push({ title, link: `${link}?ref=stackpub`, img, isArticle });
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
        const refLink = link.includes('?')
          ? `${link}&ref=stackpub`
          : `${link}?ref=stackpub`;
        return { title, link: refLink, img, isArticle };
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

// Paginated fetch — accumulates posts across Substack's 12-per-page API
// Returns { posts, nextOffset, hasMore, name, logo, substackUrl }
async function fetchSubstackBatch(publication, substackOffset = 0, limit = 24, excludeNoImage = true) {
  const isCustomDomain = publication.includes('.');

  // Build base URL list (same logic as fetchViaAPI)
  const baseUrls = [];
  if (isCustomDomain) {
    baseUrls.push(`https://${publication}`);
    const subdomain = await discoverSubstackSubdomain(publication);
    if (subdomain) baseUrls.push(`https://${subdomain}.substack.com`);
  } else {
    baseUrls.push(`https://${publication}.substack.com`);
  }

  const SUBSTACK_PAGE_SIZE = 12; // Substack's actual per-request cap

  let lastError;
  for (const baseUrl of baseUrls) {
    try {
      const linkBase = isCustomDomain ? `https://${publication}` : baseUrl;
      let filteredPosts = [];
      let currentOffset = substackOffset;
      let substackHasMore = true;

      // Keep fetching 12-post pages from Substack until we have enough filtered posts
      while (filteredPosts.length < limit && substackHasMore) {
        const url = `${baseUrl}/api/v1/archive?sort=new&search=&offset=${currentOffset}&limit=${SUBSTACK_PAGE_SIZE}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
          signal: controller.signal,
          redirect: 'follow'
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Non-array response');

        // No more posts from Substack
        if (data.length === 0) { substackHasMore = false; break; }

        for (const post of data) {
          const title = post.title || '';
          const slug = post.slug || '';
          const img = post.cover_image || '';
          const postType = post.type || 'newsletter';
          const isArticle = (postType === 'newsletter' || postType === 'thread');

          if (!title) continue;

          // Apply filtering inline
          if (excludeNoImage && (!img || isArticle === false)) continue;

          filteredPosts.push({
            title,
            link: `${linkBase}/p/${slug}?ref=stackpub`,
            img,
            isArticle
          });
        }

        currentOffset += data.length;

        // If Substack returned fewer than a full page, we've hit the end
        if (data.length < SUBSTACK_PAGE_SIZE) { substackHasMore = false; }
      }

      // Trim to requested limit
      const posts = filteredPosts.slice(0, limit);
      const hasMore = substackHasMore || filteredPosts.length > limit;
      const nextOffset = currentOffset;

      // Get publication metadata on first call
      let name = publication, logo = '', substackUrl = isCustomDomain ? `https://${publication}` : baseUrl;
      if (substackOffset === 0) {
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
      }

      return { posts, nextOffset, hasMore, name, logo, substackUrl };
    } catch (e) {
      lastError = e;
    }
  }

  // Fallback: if API batch failed and this is the first page, try RSS
  if (substackOffset === 0) {
    try {
      const rssFeed = await fetchViaRSS(publication);
      let posts = rssFeed.posts;
      if (excludeNoImage) posts = posts.filter(p => p.img && p.isArticle !== false);
      return {
        posts: posts.slice(0, limit),
        nextOffset: null,
        hasMore: false,
        name: rssFeed.name,
        logo: rssFeed.logo,
        substackUrl: rssFeed.substackUrl
      };
    } catch (e) {}
  }

  throw lastError || new Error('Could not fetch posts');
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
  const validation = validatePublicationUrl(publicationUrl);
  if (!validation.valid) return res.status(400).json({ error: validation.error });
  const publication = parseSubstackUrl(publicationUrl);
  if (!publication) return res.status(400).json({ error: 'Could not parse URL' });
  try {
    // Use API only (no RSS fallback) to confirm this is actually a Substack publication
    const feed = await fetchViaAPI(publication);
    res.json({
      name: feed.name,
      logo: feed.logo,
      postCount: feed.posts.length,
      publication,
      verified: true
    });
  } catch (e) {
    res.status(400).json({ error: 'Could not verify as a Substack publication' });
  }
});

// Claim a page (requires auth)
app.post('/api/claim', requireAuth, async (req, res) => {
  const { publicationUrl, slug, displayName, textStyle } = req.body;
  if (!publicationUrl || !slug || !displayName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const urlValidation = validatePublicationUrl(publicationUrl);
  if (!urlValidation.valid) return res.status(400).json({ error: urlValidation.error });

  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (cleanSlug.length < 3 || cleanSlug.length > 40) {
    return res.status(400).json({ error: 'Slug must be 3-40 characters' });
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
  const { displayName, textStyle, imageFilter, colorOverlay, logoUrl, excludeNoImage, slug, publicationUrl } = req.body;
  const updates = {};
  if (displayName !== undefined) updates.display_name = displayName;
  if (textStyle !== undefined) updates.text_style = textStyle;
  if (imageFilter !== undefined) updates.image_filter = imageFilter;
  if (colorOverlay !== undefined) updates.color_overlay = colorOverlay;
  if (logoUrl !== undefined) updates.logo_url = logoUrl;
  if (excludeNoImage !== undefined) updates.exclude_no_image = excludeNoImage;

  // Handle slug change
  if (slug !== undefined) {
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (cleanSlug.length < 3 || cleanSlug.length > 40) {
      return res.status(400).json({ error: 'URL must be 3-40 characters' });
    }
    const reserved = ['api', 'login', 'dashboard', 'coming-soon', 'terms', 'privacy', 'contact', 'favicon.ico'];
    if (reserved.includes(cleanSlug)) {
      return res.status(400).json({ error: 'That URL is reserved' });
    }
    // Check if slug is different from current
    const { data: currentPage } = await req.authClient.from('pages')
      .select('slug').eq('user_id', req.user.id).single();
    if (currentPage && currentPage.slug !== cleanSlug) {
      // Check availability
      const { data: taken } = await supabase.from('pages')
        .select('slug').eq('slug', cleanSlug).single();
      if (taken) {
        return res.status(400).json({ error: `stack.pub/${cleanSlug} is already taken` });
      }
      updates.slug = cleanSlug;
    }
  }

  // Handle publication URL change
  if (publicationUrl !== undefined) {
    const urlValidation = validatePublicationUrl(publicationUrl);
    if (!urlValidation.valid) return res.status(400).json({ error: urlValidation.error });
    updates.publication_url = publicationUrl;
  }

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

// Waitlist for non-Substack platforms
app.post('/api/waitlist', async (req, res) => {
  const { email, domain } = req.body;
  if (!email || !domain) return res.status(400).json({ error: 'Email and domain required' });
  try {
    const { error } = await supabase.from('waitlist').insert({ email, domain });
    if (error) {
      // Duplicate email+domain is fine, just ignore
      if (error.code === '23505') return res.json({ ok: true });
      throw error;
    }
    res.json({ ok: true });
  } catch (e) {
    console.log('Waitlist error:', e.message);
    res.json({ ok: true }); // Don't expose errors to user
  }
});

// ─── Stripe billing routes ──────────────────────────────────────────────────

// Create checkout session
app.post('/api/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const { plan } = req.body; // 'monthly' or 'annual'
  const priceId = plan === 'annual' ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
  if (!priceId) return res.status(400).json({ error: 'Price not configured' });

  // Get user's page
  const { data: page } = await req.authClient.from('pages')
    .select('*').eq('user_id', req.user.id).single();
  if (!page) return res.status(400).json({ error: 'No page found. Claim a page first.' });

  try {
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${req.headers.origin || 'https://stackpub-app-production.up.railway.app'}/dashboard?upgraded=1`,
      cancel_url: `${req.headers.origin || 'https://stackpub-app-production.up.railway.app'}/dashboard`,
      metadata: { user_id: req.user.id, slug: page.slug },
      subscription_data: {
        metadata: { user_id: req.user.id, slug: page.slug },
        description: 'STACK.PUB'
      }
    };

    // Reuse existing Stripe customer if they have one
    if (page.stripe_customer_id) {
      sessionParams.customer = page.stripe_customer_id;
    } else {
      sessionParams.customer_email = req.user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    console.log('Checkout error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Get billing status
app.get('/api/billing', requireAuth, async (req, res) => {
  const { data: page } = await req.authClient.from('pages')
    .select('is_paid, stripe_customer_id, stripe_subscription_id').eq('user_id', req.user.id).single();
  if (!page) return res.json({ isPaid: false });

  let subscription = null;
  if (stripe && page.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(page.stripe_subscription_id);
      subscription = {
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        plan: sub.items.data[0]?.price?.recurring?.interval === 'year' ? 'annual' : 'monthly',
        amount: sub.items.data[0]?.price?.unit_amount
      };
    } catch (e) {}
  }

  res.json({ isPaid: page.is_paid || false, subscription });
});

// Redirect to Stripe customer portal (manage/cancel subscription)
app.post('/api/billing-portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const { data: page } = await req.authClient.from('pages')
    .select('stripe_customer_id').eq('user_id', req.user.id).single();
  if (!page?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: page.stripe_customer_id,
      return_url: `${req.headers.origin || 'https://stackpub-app-production.up.railway.app'}/dashboard`
    });
    res.json({ url: portalSession.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Static pages ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public/terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public/privacy.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public/contact.html')));
app.get('/coming-soon', (req, res) => {
  const domain = req.query.domain || '';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Coming Soon — stack.pub</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=Lora:wght@500;600&display=swap" rel="stylesheet" />
  <style>*{box-sizing:border-box;margin:0;padding:0}html{background:#fafaf8}body{font-family:'DM Sans',sans-serif;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;-webkit-font-smoothing:antialiased}
  .logo{margin-bottom:32px}.logo svg{height:36px;width:auto;display:block}
  h1{font-family:'Lora',serif;font-size:28px;font-weight:600;margin-bottom:12px}
  p{font-size:16px;color:#777;line-height:1.6;max-width:400px;margin-bottom:24px}
  .domain{font-weight:600;color:#1a1a1a}
  .email-form{display:flex;gap:8px;max-width:380px;width:100%}
  .email-form input{flex:1;padding:12px 14px;border:1px solid #e0e0e0;border-radius:10px;font-size:15px;font-family:'DM Sans',sans-serif;outline:none}
  .email-form input:focus{border-color:#1a1a1a}
  .email-form button{padding:12px 20px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-weight:600;font-size:14px;cursor:pointer}
  .email-form button:hover{background:#333}
  .success{display:none;font-size:14px;color:#43a047;font-weight:500}
  </style></head><body>
  <div class="logo"><svg viewBox="10 5 220 70" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="12" width="18" height="24" rx="2" fill="#000000"/><rect x="41" y="12" width="18" height="24" rx="2" fill="#000000" fill-opacity="0.12"/><rect x="62" y="12" width="18" height="24" rx="2" fill="#000000" fill-opacity="0.12"/><rect x="20" y="39" width="18" height="24" rx="2" fill="#000000" fill-opacity="0.12"/><rect x="41" y="39" width="18" height="24" rx="2" fill="#000000" fill-opacity="0.12"/><rect x="62" y="39" width="18" height="24" rx="2" fill="#000000" fill-opacity="0.12"/><text x="92" y="40" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="28" font-weight="500" fill="#000000" letter-spacing="-0.5">stack.pub</text></svg></div>
  <h1>Coming soon</h1>
  <p>stack.pub currently supports Substack publications${domain ? `. We don't yet support <span class="domain">${esc(domain)}</span>` : ''}, but other platforms are on the way.</p>
  <p>Leave your email and we'll notify you as soon as your platform is supported.</p>
  <div class="email-form" id="form"><input type="email" id="csEmail" placeholder="you@example.com" /><button onclick="notify()">Notify me</button></div>
  <p class="success" id="success">You're on the list! We'll be in touch.</p>
  <script>
  async function notify(){
    const email=document.getElementById('csEmail').value.trim();
    if(!email)return;
    document.getElementById('form').style.display='none';
    document.getElementById('success').style.display='block';
  }
  </script></body></html>`);
});

// ─── Posts API (for client-side loading) ─────────────────────────────────────
app.get('/api/posts/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const preview = req.query.preview === '1';
  const { data: page } = await supabase.from('pages')
    .select('*').eq('slug', slug).single();
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const publication = parseSubstackUrl(page.publication_url);
  try {
    if (preview) {
      // Dashboard preview — only fetch first batch for preview images
      const isCustomDomain = publication.includes('.');
      const baseUrl = isCustomDomain ? `https://${publication}` : `https://${publication}.substack.com`;
      const url = `${baseUrl}/api/v1/archive?sort=new&search=&offset=0&limit=12`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' } });
      let posts = [];
      if (r.ok) {
        const data = await r.json();
        posts = (Array.isArray(data) ? data : []).map(p => ({
          title: p.title || '', link: '', img: p.cover_image || '', isArticle: true
        })).filter(p => p.img);
      }
      return res.json({ posts, substackUrl: page.publication_url, postCount: posts.length });
    }

    // Paginated fetch for portfolio pages
    const limit = Math.min(parseInt(req.query.limit) || 24, 60);
    const offset = parseInt(req.query.offset) || 0;
    const excludeNoImage = page.exclude_no_image;

    const batch = await fetchSubstackBatch(publication, offset, limit, excludeNoImage);

    res.json({
      posts: batch.posts,
      substackUrl: batch.substackUrl || page.publication_url,
      logo: page.logo_url || batch.logo || '',
      postCount: batch.posts.length,
      hasMore: batch.hasMore,
      nextOffset: batch.nextOffset
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Public portfolio page (instant shell, posts load client-side) ───────────
app.get('/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  if (['api', 'login', 'dashboard', 'coming-soon', 'terms', 'privacy', 'contact', 'favicon.ico'].includes(slug)) return res.status(404).end();

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
    publicationUrl: page.publication_url,
    isPaid: page.is_paid || false
  }));
});

// ─── Portfolio page renderer (composable styles) ─────────────────────────────
const textStyleFonts = {
  broadsheet: {
    import: "family=Inter:wght@500;600&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Inter', sans-serif", body: "'DM Sans', sans-serif"
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
        display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden;
      }`,
    byline: `
      .card .overlay {
        display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
        text-align: center; padding: 7cqi;
        background: linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.35) 25%, rgba(0,0,0,0.12) 50%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400; font-size: 9.5cqi;
        font-style: italic; color: #fff; line-height: 1.15;
        text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 2px 10px rgba(0,0,0,0.5), 0 0 24px rgba(0,0,0,0.3);
        display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
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
        text-align: center; padding: 8cqi 10cqi; background: rgba(0,0,0,0.15);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 700; font-size: 11cqi;
        color: #fff; line-height: 1.5; letter-spacing: 0.02em;
        padding: 4cqi 2cqi;
        text-shadow: 0 2px 6px rgba(0,0,0,0.7), 0 0 20px rgba(0,0,0,0.4);
        display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
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

function renderPageShell({ slug, displayName, logoUrl, textStyle, imageFilter, colorOverlay, publicationUrl, isPaid }) {
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
    .logo { max-width: clamp(160px, 42vw, 280px); max-height: 80px; width: auto; height: auto; display: block; object-fit: contain; }
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
    .sp-float {
      position: fixed; bottom: 16px; right: 16px; z-index: 100;
      background: #fff; border-radius: 50px; box-shadow: 0 4px 20px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06);
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px 8px 10px;
      font-family: 'DM Sans', sans-serif; cursor: pointer; color: #1a1a1a;
      transition: box-shadow 0.2s;
    }
    .sp-float:hover { box-shadow: 0 6px 28px rgba(0,0,0,0.16), 0 0 0 1px rgba(0,0,0,0.08); }
    .sp-float-icon { display: flex; flex-shrink: 0; }
    .sp-float-icon svg { width: 20px; height: 20px; }
    .sp-float-text { font-size: 12px; font-weight: 600; white-space: nowrap; }
    @media (max-width: 480px) {
      .sp-float { bottom: 14px; left: 50%; right: auto; transform: translateX(-50%); padding: 10px 18px 10px 14px; gap: 8px; }
      .sp-float-icon svg { width: 22px; height: 22px; }
      .sp-float-text { font-size: 13px; }
    }
    .sp-overlay {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.45); align-items: center; justify-content: center;
      font-family: 'DM Sans', sans-serif;
    }
    .sp-overlay.open { display: flex; }
    .sp-modal {
      background: #fff; border-radius: 16px; padding: 36px; max-width: 440px; width: calc(100% - 48px);
      box-shadow: 0 20px 60px rgba(0,0,0,0.2); text-align: center;
    }
    .sp-modal-icon { margin-bottom: 16px; }
    .sp-modal-icon svg { width: 40px; height: 40px; }
    .sp-modal h2 { font-family: 'DM Sans', sans-serif; font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .sp-modal p { font-size: 14px; color: #888; line-height: 1.5; margin-bottom: 20px; }
    .sp-modal-input { width: 100%; padding: 14px 16px; border: 1px solid #e0e0e0; border-radius: 10px; font-size: 15px; font-family: 'DM Sans', sans-serif; outline: none; margin-bottom: 12px; text-align: center; }
    .sp-modal-input:focus { border-color: #1a1a1a; }
    .sp-modal-input.left { text-align: left; }
    .sp-modal-go { width: 100%; padding: 14px; background: #1a1a1a; color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; font-family: 'DM Sans', sans-serif; cursor: pointer; transition: background 0.2s; }
    .sp-modal-go:hover { background: #333; }
    .sp-modal-go:disabled { opacity: 0.35; cursor: default; }
    .sp-modal-hint { font-size: 12px; color: #bbb; margin-top: 12px; }
    .sp-modal-error { font-size: 13px; color: #e05252; margin-top: 10px; display: none; }
    .sp-modal-back { font-size: 13px; color: #aaa; cursor: pointer; margin-top: 14px; display: inline-block; text-decoration: none; }
    .sp-modal-back:hover { color: #666; }
    .sp-otp-row { display: flex; gap: 8px; justify-content: center; margin-bottom: 16px; }
    .sp-otp-row input {
      width: 44px; height: 52px; text-align: center; font-size: 22px; font-weight: 600;
      font-family: 'DM Sans', sans-serif; border: 1px solid #e0e0e0; border-radius: 10px;
      outline: none; background: #fafafa; transition: border-color 0.2s;
    }
    .sp-otp-row input:focus { border-color: #1a1a1a; background: #fff; }
    .sp-step { display: none; }
    .sp-step.active { display: block; }
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
  ${!isPaid ? `
  <div class="sp-float" onclick="openModal()">
    <div class="sp-float-icon"><svg viewBox="0 0 100 75" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="28" height="34" rx="3" fill="#1a1a1a"/><rect x="33" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="0" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="33" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/></svg></div>
    <span class="sp-float-text">Create yours for free</span>
  </div>
  <div class="sp-overlay" id="spOverlay" onclick="closeModal(event)">
    <div class="sp-modal">

      <!-- Step 1: Newsletter URL -->
      <div class="sp-step active" id="spStep1">
        <div class="sp-modal-icon"><svg viewBox="0 0 100 75" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="28" height="34" rx="3" fill="#1a1a1a"/><rect x="33" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="0" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="33" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/></svg></div>
        <h2>Create your visual portfolio</h2>
        <p>Turn your Substack newsletter into a shareable photo grid like this one.</p>
        <input class="sp-modal-input left" id="spPubUrl" type="text" placeholder="yourname.substack.com" />
        <button class="sp-modal-go" onclick="spContinueUrl()">Continue</button>
        <p class="sp-modal-hint">Works with Substack URLs and custom domains.</p>
        <p class="sp-modal-error" id="spError1"></p>
      </div>

      <!-- Step 2: Email (Substack path) -->
      <div class="sp-step" id="spStep2">
        <div class="sp-modal-icon"><svg viewBox="0 0 100 75" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="28" height="34" rx="3" fill="#1a1a1a"/><rect x="33" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="0" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="33" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/></svg></div>
        <h2>Enter your email</h2>
        <p>We'll send you a 6-digit code to sign in. No password needed.</p>
        <input class="sp-modal-input" id="spEmail" type="email" placeholder="you@example.com" />
        <button class="sp-modal-go" onclick="spSendCode()">Get started</button>
        <p class="sp-modal-hint">Create your page for free.</p>
        <p class="sp-modal-error" id="spError2"></p>
        <a class="sp-modal-back" onclick="spGoStep(1)">&larr; Back</a>
      </div>

      <!-- Step 3: OTP Code -->
      <div class="sp-step" id="spStep3">
        <div class="sp-modal-icon"><svg viewBox="0 0 100 75" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="28" height="34" rx="3" fill="#1a1a1a"/><rect x="33" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="0" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="33" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/></svg></div>
        <h2>Check your email</h2>
        <p>Enter the 6-digit code we sent to <strong id="spEmailDisplay"></strong></p>
        <div class="sp-otp-row" id="spOtpRow">
          <input type="text" maxlength="1" inputmode="numeric" autocomplete="one-time-code" />
          <input type="text" maxlength="1" inputmode="numeric" />
          <input type="text" maxlength="1" inputmode="numeric" />
          <input type="text" maxlength="1" inputmode="numeric" />
          <input type="text" maxlength="1" inputmode="numeric" />
          <input type="text" maxlength="1" inputmode="numeric" />
        </div>
        <button class="sp-modal-go" id="spVerifyBtn" onclick="spVerifyCode()" disabled>Verify</button>
        <p class="sp-modal-error" id="spError3"></p>
        <a class="sp-modal-back" onclick="spResendCode()">Didn't get it? Resend code</a>
      </div>

      <!-- Step W: Waitlist (unsupported platform) -->
      <div class="sp-step" id="spStepW">
        <div class="sp-modal-icon"><svg viewBox="0 0 100 75" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="28" height="34" rx="3" fill="#1a1a1a"/><rect x="33" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="0" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="33" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/></svg></div>
        <h2>We're expanding</h2>
        <p>We couldn't connect to this publication. stack.pub currently works with Substack newsletters. If you're on another platform, leave your email — we want to build for you.</p>
        <input class="sp-modal-input" id="spWaitEmail" type="email" placeholder="you@example.com" />
        <button class="sp-modal-go" onclick="spJoinWaitlist()">Notify me</button>
        <p class="sp-modal-error" id="spErrorW"></p>
        <a class="sp-modal-back" onclick="spGoStep(1)">&larr; Try a different URL</a>
      </div>

      <!-- Step WD: Waitlist done -->
      <div class="sp-step" id="spStepWD">
        <div class="sp-modal-icon"><svg viewBox="0 0 100 75" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="28" height="34" rx="3" fill="#1a1a1a"/><rect x="33" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="0" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="0" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="33" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/><rect x="66" y="39" width="28" height="34" rx="3" fill="#1a1a1a" fill-opacity="0.15"/></svg></div>
        <h2>You're on the list</h2>
        <p>We'll let you know as soon as we can support your publication. Thanks for your interest!</p>
      </div>

    </div>
  </div>
  ` : ''}
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
  <script>
    const SUPABASE_URL = '${SUPABASE_URL}';
    const SUPABASE_KEY = '${SUPABASE_ANON_KEY}';
    const spSb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    let spPubUrlValue = '';
    let spEmailValue = '';

    function openModal() {
      // If already logged in, go straight to dashboard
      spSb.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          window.location.href = '/dashboard';
        } else {
          resetModal();
          document.getElementById('spOverlay').classList.add('open');
        }
      });
    }

    function closeModal(e) {
      if (e.target === document.getElementById('spOverlay')) {
        document.getElementById('spOverlay').classList.remove('open');
        setTimeout(resetModal, 300);
      }
    }

    function resetModal() {
      document.querySelectorAll('.sp-step').forEach(s => s.classList.remove('active'));
      document.getElementById('spStep1').classList.add('active');
      document.getElementById('spPubUrl').value = '';
      document.getElementById('spEmail').value = '';
      document.getElementById('spWaitEmail').value = '';
      document.querySelectorAll('.sp-otp-row input').forEach(i => i.value = '');
      document.querySelectorAll('.sp-modal-error').forEach(e => { e.style.display = 'none'; e.textContent = ''; });
      document.querySelectorAll('.sp-modal-go').forEach(b => { b.disabled = false; });
    }

    function spGoStep(n) {
      document.querySelectorAll('.sp-step').forEach(s => s.classList.remove('active'));
      const stepId = typeof n === 'string' ? n : 'spStep' + n;
      document.getElementById(stepId).classList.add('active');
    }

    function spShowError(id, msg) {
      const el = document.getElementById(id);
      el.textContent = msg; el.style.display = 'block';
    }

    // Step 1: Validate URL against API
    async function spContinueUrl() {
      const raw = document.getElementById('spPubUrl').value.trim();
      if (!raw) return spShowError('spError1', 'Please enter your newsletter URL.');

      // Client-side URL validation
      const clean = raw.toLowerCase().replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
      if (/^@/.test(clean) || /^substack\\.com\\/@/.test(clean) || /^substack\\.com\\/profile/.test(clean)) {
        return spShowError('spError1', 'That\\'s your Substack profile page. Your publication URL should be yourname.substack.com or your custom domain.');
      }
      if (/^(open\\.)?substack\\.com(\\/.*)?$/.test(clean) && !/^[a-z0-9_-]+\\.substack\\.com/.test(clean)) {
        return spShowError('spError1', 'That\\'s the Substack homepage. Your publication URL should be yourname.substack.com or your custom domain.');
      }

      const btn = document.querySelector('#spStep1 .sp-modal-go');
      btn.disabled = true; btn.textContent = 'Checking...';
      document.getElementById('spError1').style.display = 'none';

      try {
        const res = await fetch('/api/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicationUrl: raw })
        });

        if (res.ok) {
          const data = await res.json();
          if (data.postCount > 0) {
            spPubUrlValue = raw;
            btn.disabled = false; btn.textContent = 'Continue';
            spGoStep(2);
            setTimeout(() => document.getElementById('spEmail').focus(), 100);
            return;
          }
        } else {
          // Show server validation error if it's a URL format issue
          try {
            const errData = await res.json();
            if (errData.error && res.status === 400) {
              spShowError('spError1', errData.error);
              btn.disabled = false; btn.textContent = 'Continue';
              return;
            }
          } catch (e) {}
        }

        // Could not validate — show waitlist
        spPubUrlValue = raw;
        btn.disabled = false; btn.textContent = 'Continue';
        spGoStep('spStepW');
      } catch (e) {
        spPubUrlValue = raw;
        btn.disabled = false; btn.textContent = 'Continue';
        spGoStep('spStepW');
      }
    }

    // Step 2: Send OTP
    async function spSendCode() {
      const email = document.getElementById('spEmail').value.trim();
      if (!email || !email.includes('@')) return spShowError('spError2', 'Please enter a valid email.');

      const btn = document.querySelector('#spStep2 .sp-modal-go');
      btn.disabled = true; btn.textContent = 'Sending code...';
      document.getElementById('spError2').style.display = 'none';

      try {
        const { error } = await spSb.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: true }
        });
        if (error) throw error;

        spEmailValue = email;
        document.getElementById('spEmailDisplay').textContent = email;
        spGoStep(3);

        // Focus first OTP input
        const firstInput = document.querySelector('#spOtpRow input');
        if (firstInput) setTimeout(() => firstInput.focus(), 100);
      } catch (e) {
        spShowError('spError2', e.message || 'Could not send code. Please try again.');
        btn.disabled = false; btn.textContent = 'Get started';
      }
    }

    // Step 3: OTP input behavior
    (function setupOtp() {
      const row = document.getElementById('spOtpRow');
      if (!row) return;
      const inputs = row.querySelectorAll('input');

      inputs.forEach((inp, i) => {
        inp.addEventListener('input', (e) => {
          const val = e.target.value.replace(/[^0-9]/g, '');
          e.target.value = val.slice(0, 1);
          if (val && i < inputs.length - 1) inputs[i + 1].focus();
          checkOtpComplete();
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && i > 0) {
            inputs[i - 1].focus();
            inputs[i - 1].value = '';
          }
        });
        inp.addEventListener('paste', (e) => {
          e.preventDefault();
          const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '').slice(0, 6);
          paste.split('').forEach((ch, j) => { if (inputs[j]) inputs[j].value = ch; });
          if (paste.length > 0) inputs[Math.min(paste.length, inputs.length) - 1].focus();
          checkOtpComplete();
        });
      });

      function checkOtpComplete() {
        const code = Array.from(inputs).map(i => i.value).join('');
        document.getElementById('spVerifyBtn').disabled = code.length !== 6;
      }
    })();

    // Step 3: Verify OTP
    async function spVerifyCode() {
      const inputs = document.querySelectorAll('#spOtpRow input');
      const code = Array.from(inputs).map(i => i.value).join('');
      if (code.length !== 6) return;

      const btn = document.getElementById('spVerifyBtn');
      btn.disabled = true; btn.textContent = 'Verifying...';
      document.getElementById('spError3').style.display = 'none';

      try {
        const { data, error } = await spSb.auth.verifyOtp({
          email: spEmailValue,
          token: code,
          type: 'email'
        });
        if (error) throw error;

        // Success — redirect to dashboard with pub URL
        window.location.href = '/dashboard?pub=' + encodeURIComponent(spPubUrlValue);
      } catch (e) {
        spShowError('spError3', 'Invalid code. Please try again.');
        btn.disabled = false; btn.textContent = 'Verify';
        inputs.forEach(i => i.value = '');
        inputs[0].focus();
      }
    }

    // Resend code
    async function spResendCode() {
      if (!spEmailValue) return;
      try {
        await spSb.auth.signInWithOtp({ email: spEmailValue, options: { shouldCreateUser: true } });
        const el = document.querySelector('#spStep3 .sp-modal-back');
        const orig = el.textContent;
        el.textContent = 'Code resent!';
        setTimeout(() => { el.textContent = orig; }, 3000);
      } catch (e) {}
    }

    // Waitlist
    async function spJoinWaitlist() {
      const email = document.getElementById('spWaitEmail').value.trim();
      if (!email || !email.includes('@')) return spShowError('spErrorW', 'Please enter a valid email.');

      const btn = document.querySelector('#spStepW .sp-modal-go');
      btn.disabled = true; btn.textContent = 'Saving...';

      try {
        await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, domain: spPubUrlValue })
        });
        spGoStep('spStepWD');
      } catch (e) {
        spShowError('spErrorW', 'Something went wrong. Please try again.');
        btn.disabled = false; btn.textContent = 'Notify me';
      }
    }

    // Portfolio page logic
    const slug = '${esc(slug)}';
    let nextOffset = 0;
    let hasMore = true;
    let isLoading = false;
    let totalPosts = 0;

    async function loadPosts(initial) {
      if (isLoading || !hasMore) return;
      isLoading = true;
      try {
        const url = '/api/posts/' + slug + '?limit=24&offset=' + nextOffset;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        if (initial && data.substackUrl) document.getElementById('subscribeBtn').href = data.substackUrl + '/subscribe';
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
        totalPosts += data.posts.length;
        hasMore = data.hasMore && data.posts.length > 0;
        nextOffset = data.nextOffset || 0;
        document.getElementById('postCount').textContent = totalPosts;
        if (initial) {
          document.getElementById('footer').style.display = 'block';
          document.getElementById('loading').style.display = 'none';
        }
        // Hide the scroll sentinel loading indicator
        const sentinel = document.getElementById('scrollSentinel');
        if (sentinel) sentinel.style.display = hasMore ? 'block' : 'none';
      } catch (e) {
        if (initial) document.getElementById('loading').innerHTML = '<p class="loading-text">Could not load stories. Please try again.</p>';
      }
      isLoading = false;
    }

    function escHTML(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

    // Initial load
    loadPosts(true);

    // Infinite scroll — observe a sentinel element below the grid
    const sentinel = document.createElement('div');
    sentinel.id = 'scrollSentinel';
    sentinel.style.cssText = 'text-align:center;padding:32px 24px;font-size:12px;color:#ccc;';
    sentinel.textContent = 'Loading more...';
    document.getElementById('grid').insertAdjacentElement('afterend', sentinel);

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) loadPosts(false);
      }, { rootMargin: '400px' });
      observer.observe(sentinel);
    }
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
