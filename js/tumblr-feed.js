/*
 * Renders the Evolfo Tumblr blog inline.
 *
 * Tumblr put a bot-check page in front of evolfo.tumblr.com, so the blog can no
 * longer be shown in an iframe. The legacy JSON API is still open and can be
 * loaded with a <script> tag (JSONP), so we fetch posts from there and draw them.
 */
(function () {
    'use strict';

    var BLOG = 'https://evolfo.tumblr.com';
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

    // ---- post renderers ---------------------------------------------------

    function photoImg(url, alt) {
        var img = el('img', 'tf-photo');
        img.src = url;
        img.alt = alt || '';
        img.loading = 'lazy';
        return img;
    }

    var renderers = {
        regular: function (post, body) {
            if (post['regular-title']) {
                var h = el('h3', 'tf-title');
                h.textContent = post['regular-title'];
                body.appendChild(h);
            }
            body.appendChild(html(el('div', 'tf-text'), post['regular-body']));
        },

        photo: function (post, body) {
            var photos = post.photos && post.photos.length ? post.photos : [post];
            photos.forEach(function (p) {
                var src = p['photo-url-1280'] || p['photo-url-500'];
                if (!src) { return; }
                var img = photoImg(src);
                if (post['photo-link-url'] && isSafeLink(post['photo-link-url'])) {
                    var a = el('a', 'tf-photo-link');
                    a.href = post['photo-link-url'];
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.appendChild(img);
                    body.appendChild(a);
                } else {
                    body.appendChild(img);
                }
            });
            if (post['photo-caption']) {
                body.appendChild(html(el('div', 'tf-text'), post['photo-caption']));
            }
        },

        link: function (post, body) {
            if (post['link-url']) {
                var h = el('h3', 'tf-title');
                h.appendChild(externalLink(post['link-url'], post['link-text'] || post['link-url']));
                body.appendChild(h);
            }
            if (post['link-description']) {
                body.appendChild(html(el('div', 'tf-text'), post['link-description']));
            }
        },

        video: function (post, body) {
            var player = html(el('div', 'tf-video'), post['video-player-500'] || post['video-player']);
            if (player.querySelector('iframe, video')) {
                body.appendChild(player);
            } else if (post['video-source'] && isSafeLink(post['video-source'])) {
                body.appendChild(externalLink(post['video-source'], 'Watch video', 'tf-title'));
            }
            if (post['video-caption']) {
                body.appendChild(html(el('div', 'tf-text'), post['video-caption']));
            }
        }
    };

    function renderPost(post) {
        var card = el('article', 'tf-post tf-' + post.type);
        var body = el('div', 'tf-body');
        (renderers[post.type] || renderers.regular)(post, body);

        // Nothing we know how to show: skip rather than draw an empty card.
        if (!body.firstChild) { return null; }
        card.appendChild(body);

        var foot = el('footer', 'tf-meta');
        foot.appendChild(externalLink(post['url-with-slug'] || post.url, formatDate(post['unix-timestamp']), 'tf-date'));
        card.appendChild(foot);
        return card;
    }

    // ---- loading ----------------------------------------------------------

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
            setError('Couldn’t load posts right now.');
        }

        window[CALLBACK] = function (data) {
            if (done) { return; }
            cleanup();
            var posts = (data && data.posts) || [];
            total = parseInt(data && data['posts-total'], 10) || 0;
            posts.forEach(function (post) {
                var card = renderPost(post);
                if (card) { list.appendChild(card); }
            });
            nextStart += posts.length;
            more.hidden = !posts.length || nextStart >= total;
            if (list.children.length) { setStatus(''); } else { setError('No posts to show.'); }
        };

        script.onerror = fail;
        script.src = BLOG + '/api/read/json?num=' + PAGE_SIZE + '&start=' + nextStart +
            '&callback=' + CALLBACK;
        document.head.appendChild(script);
    }

    more.addEventListener('click', load);
    load();
})();
