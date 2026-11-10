/*
 * Renders the Evolfo Tumblr blog inline.
 *
 * Tumblr put a bot-check page in front of evolfo.tumblr.com, so the blog can no
 * longer be shown in an iframe. Instead we load posts with a <script> tag (JSONP)
 * from Tumblr's API and draw them ourselves. Two sources are tried in order:
 *
 *   1. The official v2 API, using a read-only OAuth consumer key.
 *   2. The legacy /api/read/json endpoint (no key), as a fallback.
 *
 * The consumer key only allows reading public blog data, so it is safe to ship in
 * client-side code. Both sources are normalized to the same post shape below.
 */
(function () {
    'use strict';

    var BLOG = 'https://evolfo.tumblr.com';
    var API_KEY = 'vzFuoFWVD7LuCmWOJfrjPbdbWZmnpnzJNuTSsrjmEbRC1jguVw';
    var PAGE_SIZE = 10;
    var TIMEOUT_MS = 10000;
    var CALLBACK = '__tumblrFeedCallback';

    // Embedded players we are willing to show inside a post.
    var IFRAME_HOSTS = [
        'www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com',
        'bandcamp.com', 'open.spotify.com', 'w.soundcloud.com'
    ];

    var root = document.getElementById('tumblr-feed');
    if (!root) { return; }

    var list = document.createElement('div');
    list.className = 'tf-list';
    var status = document.createElement('p');
    status.className = 'tf-status';
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'tf-more';
    more.textContent = 'Load more';
    more.hidden = true;

    root.textContent = '';
    root.appendChild(list);
    root.appendChild(status);
    root.appendChild(more);

    var nextStart = 0;
    var total = null;
    var loading = false;

    // ---- helpers ----------------------------------------------------------

    function el(tag, className) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        return node;
    }

    function isHttps(url) {
        try { return new URL(url, location.href).protocol === 'https:'; } catch (e) { return false; }
    }

    function isSafeLink(url) {
        try {
            var p = new URL(url, location.href).protocol;
            return p === 'https:' || p === 'http:' || p === 'mailto:';
        } catch (e) { return false; }
    }

    /**
     * Turn an HTML string from Tumblr into a DocumentFragment with only the
     * markup we expect in a blog post. DOMParser documents are inert, so nothing
     * runs or loads while we clean it.
     */
    function sanitize(html) {
        var doc = new DOMParser().parseFromString(html || '', 'text/html');
        var ALLOWED = {
            A: 1, B: 1, BLOCKQUOTE: 1, BR: 1, DIV: 1, EM: 1, FIGURE: 1, FIGCAPTION: 1,
            H1: 1, H2: 1, H3: 1, H4: 1, HR: 1, I: 1, IMG: 1, LI: 1, OL: 1, P: 1,
            SOURCE: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, U: 1, UL: 1, VIDEO: 1,
            IFRAME: 1, BODY: 1
        };
        var KEEP_ATTRS = {
            href: 1, src: 1, srcset: 1, sizes: 1, alt: 1, width: 1, height: 1, type: 1,
            poster: 1, controls: 1, preload: 1, muted: 1, loop: 1, playsinline: 1,
            allow: 1, allowfullscreen: 1, title: 1
        };

        (function walk(node) {
            Array.prototype.slice.call(node.childNodes).forEach(function (child) {
                if (child.nodeType === 3) { return; }          // text
                if (child.nodeType !== 1) { child.remove(); return; } // comments etc.

                var tag = child.tagName;
                if (!ALLOWED[tag]) {
                    // Unknown wrapper: keep its text/children, drop the tag.
                    if (/^(SCRIPT|STYLE|OBJECT|EMBED|FORM|LINK|META|NOSCRIPT)$/.test(tag)) {
                        child.remove();
                    } else {
                        walk(child);
                        while (child.firstChild) { node.insertBefore(child.firstChild, child); }
                        child.remove();
                    }
                    return;
                }

                if (tag === 'IFRAME') {
                    var host = '';
                    try { host = new URL(child.getAttribute('src') || '', location.href).hostname; } catch (e) {}
                    if (!isHttps(child.getAttribute('src')) || IFRAME_HOSTS.indexOf(host) === -1) {
                        child.remove();
                        return;
                    }
                }

                Array.prototype.slice.call(child.attributes).forEach(function (attr) {
                    var name = attr.name.toLowerCase();
                    if (!KEEP_ATTRS[name]) { child.removeAttribute(attr.name); return; }
                    if ((name === 'href') && !isSafeLink(attr.value)) { child.removeAttribute(attr.name); }
                    if ((name === 'src' || name === 'poster') && !isHttps(attr.value)) { child.removeAttribute(attr.name); }
                });

                if (tag === 'A') {
                    child.setAttribute('target', '_blank');
                    child.setAttribute('rel', 'noopener noreferrer');
                }
                if (tag === 'IMG') { child.setAttribute('loading', 'lazy'); }
                if (tag === 'IFRAME') { child.setAttribute('loading', 'lazy'); }
                if (tag === 'VIDEO') { child.setAttribute('controls', ''); child.setAttribute('preload', 'none'); }

                walk(child);
            });
        })(doc.body);

        var frag = document.createDocumentFragment();
        while (doc.body.firstChild) { frag.appendChild(doc.body.firstChild); }
        return frag;
    }

    function html(container, markup) {
        container.appendChild(sanitize(markup));
        return container;
    }

    function formatDate(ts) {
        return new Date(ts * 1000).toLocaleDateString(undefined, {
            year: 'numeric', month: 'long', day: 'numeric'
        });
    }

    function externalLink(href, text, className) {
        var a = el('a', className);
        if (isSafeLink(href)) { a.href = href; }
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = text;
        return a;
    }

    // ---- sources ----------------------------------------------------------
    // Each source builds a URL and turns the response into { posts, total },
    // where every post is { type, url, ts, title, body, photos, link, linkUrl,
    // linkText, player, videoUrl }. Return null if the response is unusable.

    function pickPlayer(players) {
        if (!players || !players.length) { return ''; }
        var best = players[players.length - 1];
        players.forEach(function (p) { if (p.width === 500) { best = p; } });
        return best.embed_code || '';
    }

    var SOURCES = [
        {
            name: 'v2',
            url: function (offset) {
                return 'https://api.tumblr.com/v2/blog/evolfo.tumblr.com/posts?api_key=' + API_KEY +
                    '&limit=' + PAGE_SIZE + '&offset=' + offset + '&callback=' + CALLBACK;
            },
            parse: function (data) {
                if (!data || !data.meta || data.meta.status !== 200 || !data.response) { return null; }
                var r = data.response;
                return {
                    total: r.total_posts || 0,
                    posts: (r.posts || []).map(function (p) {
                        return {
                            type: p.type,
                            url: p.post_url,
                            ts: p.timestamp,
                            title: p.title || '',
                            body: p.body || p.caption || '',
                            photos: (p.photos || []).map(function (x) { return x.original_size && x.original_size.url; }),
                            link: p.link_url || '',
                            linkUrl: p.url || '',
                            linkText: p.title || '',
                            linkDesc: p.description || '',
                            player: pickPlayer(p.player),
                            videoUrl: p.permalink_url || ''
                        };
                    })
                };
            }
        },
        {
            name: 'legacy',
            url: function (offset) {
                return BLOG + '/api/read/json?num=' + PAGE_SIZE + '&start=' + offset +
                    '&callback=' + CALLBACK;
            },
            parse: function (data) {
                if (!data || !data.posts) { return null; }
                return {
                    total: parseInt(data['posts-total'], 10) || 0,
                    posts: data.posts.map(function (p) {
                        var photos = p.photos && p.photos.length ? p.photos : (p['photo-url-1280'] ? [p] : []);
                        return {
                            type: { regular: 'text' }[p.type] || p.type,
                            url: p['url-with-slug'] || p.url,
                            ts: p['unix-timestamp'],
                            title: p['regular-title'] || '',
                            body: p['regular-body'] || p['photo-caption'] || p['video-caption'] || '',
                            photos: photos.map(function (x) { return x['photo-url-1280'] || x['photo-url-500']; }),
                            link: p['photo-link-url'] || '',
                            linkUrl: p['link-url'] || '',
                            linkText: p['link-text'] || '',
                            linkDesc: p['link-description'] || '',
                            player: p['video-player-500'] || p['video-player'] || '',
                            videoUrl: p['video-source'] || ''
                        };
                    })
                };
            }
        }
    ];

    // ---- post renderers ---------------------------------------------------

    function titleNode(post) {
        var h = el('h3', 'tf-title');
        h.textContent = post.title;
        return h;
    }

    var renderers = {
        text: function (post, body) {
            if (post.title) { body.appendChild(titleNode(post)); }
            body.appendChild(html(el('div', 'tf-text'), post.body));
        },

        photo: function (post, body) {
            post.photos.forEach(function (src) {
                if (!src || !isHttps(src)) { return; }
                var img = el('img', 'tf-photo');
                img.src = src;
                img.alt = '';
                img.loading = 'lazy';
                if (post.link && isSafeLink(post.link)) {
                    var a = el('a', 'tf-photo-link');
                    a.href = post.link;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.appendChild(img);
                    body.appendChild(a);
                } else {
                    body.appendChild(img);
                }
            });
            if (post.body) { body.appendChild(html(el('div', 'tf-text'), post.body)); }
        },

        link: function (post, body) {
            if (post.linkUrl) {
                var h = el('h3', 'tf-title');
                h.appendChild(externalLink(post.linkUrl, post.linkText || post.linkUrl));
                body.appendChild(h);
            }
            if (post.linkDesc) { body.appendChild(html(el('div', 'tf-text'), post.linkDesc)); }
        },

        video: function (post, body) {
            var player = html(el('div', 'tf-video'), post.player);
            if (player.querySelector('iframe, video')) {
                body.appendChild(player);
            } else if (post.videoUrl && isSafeLink(post.videoUrl)) {
                body.appendChild(externalLink(post.videoUrl, 'Watch video', 'tf-title'));
            }
            if (post.body) { body.appendChild(html(el('div', 'tf-text'), post.body)); }
        }
    };

    function renderPost(post) {
        var card = el('article', 'tf-post tf-' + post.type);
        var body = el('div', 'tf-body');
        (renderers[post.type] || renderers.text)(post, body);

        // Nothing we know how to show: skip rather than draw an empty card.
        if (!body.firstChild) { return null; }
        card.appendChild(body);

        var foot = el('footer', 'tf-meta');
        foot.appendChild(externalLink(post.url, formatDate(post.ts), 'tf-date'));
        card.appendChild(foot);
        return card;
    }

    // ---- loading ----------------------------------------------------------

    var sourceIndex = 0;
    var sourceWorked = false;

    function setStatus(message) {
        status.textContent = message || '';
        status.hidden = !message;
    }

    function setError(message) {
        setStatus(message + ' ');
        var b = el('button', 'tf-retry');
        b.type = 'button';
        b.textContent = 'Try again';
        b.addEventListener('click', load);
        status.appendChild(b);
        status.appendChild(document.createTextNode(' or '));
        status.appendChild(externalLink(BLOG + '/', 'read it on Tumblr', 'tf-fallback'));
        status.appendChild(document.createTextNode('.'));
    }

    function load() {
        if (loading) { return; }
        loading = true;
        more.disabled = true;
        setStatus(list.children.length ? 'Loading…' : 'Loading posts…');

        var source = SOURCES[sourceIndex];
        var script = document.createElement('script');
        var done = false;
        var timer = setTimeout(function () { fail(); }, TIMEOUT_MS);

        function cleanup() {
            done = true;
            clearTimeout(timer);
            delete window[CALLBACK];
            script.remove();
            loading = false;
            more.disabled = false;
        }

        function fail() {
            if (done) { return; }
            cleanup();
            // Until a source has worked once, quietly fall back to the next one.
            if (!sourceWorked && sourceIndex < SOURCES.length - 1) {
                sourceIndex += 1;
                load();
                return;
            }
            setError('Couldn’t load posts right now.');
        }

        window[CALLBACK] = function (data) {
            if (done) { return; }
            var result = source.parse(data);
            if (!result) { fail(); return; }
            cleanup();
            sourceWorked = true;
            total = result.total;
            result.posts.forEach(function (post) {
                var card = renderPost(post);
                if (card) { list.appendChild(card); }
            });
            nextStart += result.posts.length;
            more.hidden = !result.posts.length || nextStart >= total;
            if (list.children.length) { setStatus(''); } else { setError('No posts to show.'); }
        };

        script.onerror = fail;
        script.src = source.url(nextStart);
        document.head.appendChild(script);
    }

    more.addEventListener('click', load);
    load();
})();
