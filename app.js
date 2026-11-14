/* Hindi News v4 — reel-style player.
   One merged feed (newest first) across 5 Hindi news channels.
   Start gate: tap the big Start button and the newest video plays with sound.
   Skip like a reel: swipe left/right, scroll, arrow keys, or Prev / Next.
   Navigation slides the video + headline in the direction you moved.
   The headline sits under the video in full (never clipped); the video's
   thumbnail, blurred and darkened, fills the screen behind it.
   Data: videos.json (snapshot). Live refresh on load fetches each channel's
   YouTube RSS through public proxies, round-robin (see tryLiveRefresh).
   Proxy test results, 2026-11-14: only rss2json returns the feed. allorigins,
   cors.dev and cors.lol fetch fine but YouTube answers them with a 404 —
   Google blocks datacenter IPs, which is also why plain curl from a server
   404s. codetabs 522s, cors.eu.org 403s (Cloudflare challenge). corsproxy.io,
   corsproxy.dev and Corsfix need API keys, so they are not used. A Cloudflare
   Worker of our own would run on datacenter IPs too, so it would likely hit
   the same YouTube 404 — rss2json is the working route for now. */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var data = null;          // {generatedAt, channels, videos}
  var list = [];            // all videos, newest first (no channel filter UI)
  var index = 0, prevIndex = 0;
  var player = null, playerReady = false, apiReady = false, dataReady = false;
  var started = false, muted = true, liveNote = '';
  var currentId = null;
  var io = null, actTimer = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* Precise relative time — no rounding: "43 min ago", "1 h 23 min ago". */
  function relTime(ts) {
    var s = Math.floor(Date.now() / 1000) - ts;
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) {
      var rm = m % 60;
      return rm ? h + ' h ' + rm + ' min ago' : h + ' h ago';
    }
    var d = Math.floor(h / 24);
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + ' days ago';
    return new Date(ts * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  function thumb(id) { return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'; }
  function metaText(v) {
    return v.channel + ' • ' + relTime(v.ts) + ' • ' + (index + 1) + ' / ' + list.length;
  }

  /* ---------- data ---------- */

  function loadData() {
    fetch('videos.json?v=4')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        data = d;
        list = data.videos.slice();
        buildReel();
        buildList();
        window.scrollTo(0, 0);
        index = 0; prevIndex = 0;
        activate(0);
        dataReady = true;
        maybeInitPlayer();
        tryLiveRefresh();
      })
      .catch(function () {
        $('#ovTitle').textContent = "Couldn't load videos — check connection and tap ↻ to retry.";
      });
  }

  /* ---------- live refresh: round-robin proxies ---------- */

  /* YouTube's RSS sends no CORS headers, so the page fetches it through a
     public proxy. The list rotates its starting point on every load, and each
     channel falls through to the next proxy when one fails. rss2json returns
     JSON (10 newest items, no key needed); the others return raw XML. */
  var PROXIES = [
    { name: 'rss2json', json: true, url: function (feed) {
      return 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(feed);
    } },
    { name: 'allorigins', json: false, url: function (feed) {
      return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(feed);
    } },
    { name: 'cors.dev', json: false, url: function (feed) {
      return 'https://proxy.cors.dev/' + feed;
    } }
  ];
  var proxyStart = 0;

  function addVideo(id, title, pub, ch) {
    if (data.videos.some(function (v) { return v.id === id; })) return false;
    if (/#shorts/i.test(title)) return false;
    var ts = Math.floor(Date.parse(pub) / 1000);
    if (!ts) return false;
    data.videos.push({ id: id, title: title, channel: ch.name, published: pub, ts: ts, dur: null });
    return true;
  }

  function parseRssJson(d, ch) {
    var n = 0;
    (d.items || []).forEach(function (it) {
      if (!it.link || !it.title) return;
      var m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(it.link) ||
              /^yt:video:([A-Za-z0-9_-]{11})$/.exec(it.guid || '');
      if (!m) return;
      /* rss2json pubDate is "YYYY-MM-DD HH:MM:SS" (UTC); make it ISO first. */
      var pub = String(it.pubDate || '').replace(' ', 'T') + 'Z';
      if (addVideo(m[1], it.title, pub, ch)) n++;
    });
    return n;
  }

  function parseRssXml(text, ch) {
    var n = 0;
    var xml = new DOMParser().parseFromString(text, 'text/xml');
    var entries = xml.getElementsByTagName('entry');
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var idEl = en.getElementsByTagName('yt:videoId')[0];
      var tEl = en.getElementsByTagName('title')[0];
      var pEl = en.getElementsByTagName('published')[0];
      if (!idEl || !tEl || !pEl) continue;
      if (addVideo(idEl.textContent, tEl.textContent, pEl.textContent, ch)) n++;
    }
    return n;
  }

  function fetchViaProxy(ch, order) {
    if (!order.length) return Promise.resolve(0);
    var px = order[0];
    var feed = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.id;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(px.url(feed), { signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('http ' + r.status);
        return px.json ? r.json() : r.text();
      })
      .then(function (d) {
        return px.json ? parseRssJson(d, ch) : parseRssXml(d, ch);
      })
      .catch(function () { return fetchViaProxy(ch, order.slice(1)); });
  }

  function tryLiveRefresh() {
    if (!data) return;
    var order = PROXIES.slice(proxyStart).concat(PROXIES.slice(0, proxyStart));
    proxyStart = (proxyStart + 1) % PROXIES.length;
    var jobs = data.channels.map(function (ch) { return fetchViaProxy(ch, order); });
    Promise.all(jobs).then(function (counts) {
      var added = counts.reduce(function (a, b) { return a + b; }, 0);
      if (added > 0) {
        data.videos.sort(function (a, b) { return b.ts - a.ts; });
        var cur = list[index] ? list[index].id : null;
        liveNote = 'Live ✓';
        list = data.videos.slice();
        buildReel();
        buildList();
        window.scrollTo(0, 0);
        index = 0; prevIndex = 0;
        activate(0);
        var ni = list.findIndex(function (v) { return v.id === cur; });
        if (ni > 0) goTo(ni);
      }
    });
  }

  /* ---------- rendering ---------- */

  function buildReel() {
    if (io) io.disconnect();
    var reel = $('#reel');
    reel.innerHTML = list.map(function (v, i) {
      return '<div class="slot" data-i="' + i + '"></div>';
    }).join('');
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && e.intersectionRatio >= 0.5) {
          clearTimeout(actTimer);
          var i = +e.target.dataset.i;
          actTimer = setTimeout(function () { activate(i); }, 120);
        }
      });
    }, { threshold: 0.5 });
    reel.querySelectorAll('.slot').forEach(function (s) { io.observe(s); });
  }

  function buildList() {
    var updated = data.generatedAt
      ? relTime(Math.floor(Date.parse(data.generatedAt) / 1000)) : '';
    $('#lvMeta').textContent = list.length + ' videos • Updated ' + updated +
      (liveNote ? ' • ' + liveNote : '');
    $('#lvRows').innerHTML = list.map(function (v, i) {
      return '<button class="lv-row" data-i="' + i + '">' +
        '<img src="' + thumb(v.id) + '" alt="" loading="lazy">' +
        '<span><span class="lv-t">' + esc(v.title) + '</span>' +
        '<span class="lv-m">' + esc(v.channel) + ' • ' + relTime(v.ts) + '</span></span>' +
        '</button>';
    }).join('');
  }

  /* ---------- playback ---------- */

  function animate(dir) {
    if (reducedMotion) return;
    var el = $('#stageCard');
    var cls = dir >= 0 ? 'anim-next' : 'anim-prev';
    el.classList.remove('anim-next', 'anim-prev');
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function setBackdrop(id) {
    var bg = $('#backdropImg');
    if (bg.dataset.cur === id) return;
    bg.dataset.cur = id;
    bg.style.opacity = '0';
    bg.onload = function () { bg.style.opacity = '1'; };
    bg.onerror = function () { bg.style.opacity = '1'; };
    bg.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  }

  function activate(i) {
    if (!list.length) return;
    prevIndex = index;
    index = ((i % list.length) + list.length) % list.length;
    var v = list[index];
    $('#ovTitle').textContent = v.title;
    $('#ovMeta').textContent = metaText(v);
    document.title = v.title + ' — हिन्दी न्यूज़';
    setBackdrop(v.id);
    document.querySelectorAll('.lv-row').forEach(function (r) {
      r.classList.toggle('current', +r.dataset.i === index);
    });
    if (index !== prevIndex) animate(index > prevIndex ? 1 : -1);
    if (playerReady && currentId !== v.id) {
      currentId = v.id;
      if (started) player.loadVideoById(v.id);
      else player.cueVideoById(v.id);
    }
  }

  function goTo(i) {
    if (!list.length) return;
    i = ((i % list.length) + list.length) % list.length;
    var slot = document.querySelectorAll('.slot')[i];
    if (slot) slot.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function maybeInitPlayer() {
    if (!apiReady || !dataReady || player || !list.length) return;
    player = new YT.Player('player', {
      videoId: list[0].id,
      playerVars: {
        autoplay: 0, mute: 1, rel: 0, modestbranding: 1,
        playsinline: 1, controls: 0, disablekb: 1, fs: 0
      },
      events: {
        onReady: function () {
          playerReady = true;
          player.mute();
          activate(index);
        },
        onStateChange: function (e) {
          if (e.data === YT.PlayerState.ENDED) goTo(index + 1);
        },
        onError: function () { setTimeout(function () { goTo(index + 1); }, 600); }
      }
    });
  }

  window.onYouTubeIframeAPIReady = function () {
    apiReady = true;
    maybeInitPlayer();
  };

  /* ---------- start gate ---------- */

  function startPlayback() {
    if (started) return;
    started = true;
    muted = false;
    $('#startOverlay').classList.add('hidden');
    $('#muteBtn').textContent = '🔊';
    if (playerReady) {
      player.unMute();
      player.setVolume(100);
      player.playVideo();
    }
  }
  $('#startBtn').addEventListener('click', startPlayback);

  /* ---------- sound ---------- */

  function toggleMute() {
    if (!playerReady || !started) return;
    if (muted) {
      muted = false;
      player.unMute();
      $('#muteBtn').textContent = '🔊';
    } else {
      muted = true;
      player.mute();
      $('#muteBtn').textContent = '🔇';
    }
  }

  /* ---------- events ---------- */

  $('#taplayer').addEventListener('click', function () {
    if (!playerReady || !started) return;
    if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  });
  $('#nextBtn').addEventListener('click', function () { goTo(index + 1); });
  $('#prevBtn').addEventListener('click', function () { goTo(index - 1); });
  $('#muteBtn').addEventListener('click', toggleMute);
  $('#refreshBtn').addEventListener('click', tryLiveRefresh);
  $('#listBtn').addEventListener('click', function () {
    buildList();
    $('#listview').hidden = false;
    document.body.style.overflow = 'hidden';
  });
  $('#listClose').addEventListener('click', hideList);
  $('#lvRows').addEventListener('click', function (e) {
    var row = e.target.closest('.lv-row');
    if (!row) return;
    hideList();
    goTo(+row.dataset.i);
  });

  /* Swipe left / right to navigate. Vertical swipes keep scrolling the page. */
  var tsX = 0, tsY = 0, tsT = 0;
  document.addEventListener('touchstart', function (e) {
    if (!started) return;
    var t = e.target;
    if (t.closest('button') || t.closest('a') ||
        t.closest('#listview') || t.closest('#startOverlay')) return;
    var touch = e.changedTouches[0];
    tsX = touch.clientX; tsY = touch.clientY; tsT = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!tsT) return;
    var touch = e.changedTouches[0];
    var dx = touch.clientX - tsX, dy = touch.clientY - tsY;
    tsT = 0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) goTo(index + 1);
      else goTo(index - 1);
    }
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (!started) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'n' || e.key === 'N') startPlayback();
      return;
    }
    if (e.key === 'n' || e.key === 'N') goTo(index + 1);
    else if (e.key === 'p' || e.key === 'P') goTo(index - 1);
    else if (e.key === 'm' || e.key === 'M') toggleMute();
    else if (e.key === 'Escape') hideList();
  });

  function hideList() {
    $('#listview').hidden = true;
    document.body.style.overflow = '';
  }

  /* Keep the "x min ago" line honest while the page stays open. */
  setInterval(function () {
    if (list.length) $('#ovMeta').textContent = metaText(list[index]);
  }, 60000);

  loadData();
})();
