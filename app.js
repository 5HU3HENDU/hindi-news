/* Hindi News — reel-style player.
   One merged feed (newest first) across 5 Hindi news channels.
   Scroll / swipe / arrow keys = skip to next video. Video auto-plays muted
   on load; first tap unmutes. Auto-advances when a video ends.
   Data: videos.json (snapshot). Best-effort live refresh via the public
   YouTube RSS feeds through a CORS proxy; snapshot stands if that fails. */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var data = null;          // {generatedAt, channels, videos}
  var list = [];            // filtered videos
  var filter = 'All';
  var index = 0;
  var player = null, playerReady = false, apiReady = false, dataReady = false;
  var muted = true, justUnmuted = false, liveNote = '';
  var currentId = null;
  var io = null, actTimer = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function relTime(ts) {
    var s = Math.floor(Date.now() / 1000) - ts;
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.floor(h / 24);
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + ' days ago';
    return new Date(ts * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  function thumb(id) { return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'; }

  /* ---------- data ---------- */

  function loadData() {
    fetch('videos.json?v=1')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        data = d;
        buildChips();
        applyFilter('All');
        dataReady = true;
        maybeInitPlayer();
        tryLiveRefresh();
      })
      .catch(function () {
        $('#ovTitle').textContent = "Couldn't load videos — check connection and tap ↻ to retry.";
      });
  }

  /* Best-effort live refresh: YouTube RSS has no CORS, so go through a
     public proxy. If it fails (it often does), the snapshot just stands. */
  function tryLiveRefresh() {
    if (!data) return;
    var added = 0;
    var jobs = data.channels.map(function (ch) {
      var url = 'https://api.allorigins.win/raw?url=' +
        encodeURIComponent('https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.id);
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 8000);
      return fetch(url, { signal: ctrl.signal })
        .then(function (r) { clearTimeout(timer); if (!r.ok) return; return r.text(); })
        .then(function (text) {
          if (!text) return;
          var xml = new DOMParser().parseFromString(text, 'text/xml');
          var entries = xml.getElementsByTagName('entry');
          for (var i = 0; i < entries.length; i++) {
            var en = entries[i];
            var idEl = en.getElementsByTagName('yt:videoId')[0];
            var tEl = en.getElementsByTagName('title')[0];
            var pEl = en.getElementsByTagName('published')[0];
            if (!idEl || !tEl || !pEl) continue;
            var id = idEl.textContent;
            if (data.videos.some(function (v) { return v.id === id; })) continue;
            if (/#shorts/i.test(tEl.textContent)) continue;
            var ts = Math.floor(Date.parse(pEl.textContent) / 1000);
            if (!ts) continue;
            data.videos.push({ id: id, title: tEl.textContent, channel: ch.name, published: pEl.textContent, ts: ts, dur: null });
            added++;
          }
        })
        .catch(function () { /* proxy/feed failed — snapshot stands */ });
    });
    Promise.all(jobs).then(function () {
      if (added > 0) {
        data.videos.sort(function (a, b) { return b.ts - a.ts; });
        var cur = list[index] ? list[index].id : null;
        liveNote = 'Live ✓';
        applyFilter(filter);
        var ni = list.findIndex(function (v) { return v.id === cur; });
        if (ni > 0) goTo(ni);
      }
    });
  }

  /* ---------- rendering ---------- */

  function buildChips() {
    var names = ['All'].concat(data.channels.map(function (c) { return c.name; }));
    $('#chips').innerHTML = names.map(function (n) {
      return '<button class="chip">' + esc(n) + '</button>';
    }).join('');
  }

  function applyFilter(name) {
    filter = name;
    list = name === 'All'
      ? data.videos.slice()
      : data.videos.filter(function (v) { return v.channel === name; });
    document.querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('active', c.textContent === name);
    });
    buildReel();
    buildList();
    window.scrollTo(0, 0);
    index = 0;
    activate(0);
  }

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

  function activate(i) {
    if (!list.length) return;
    index = ((i % list.length) + list.length) % list.length;
    var v = list[index];
    $('#ovTitle').textContent = v.title;
    $('#ovMeta').textContent = v.channel + ' • ' + relTime(v.ts) +
      ' • ' + (index + 1) + ' / ' + list.length;
    $('#ytLink').href = 'https://www.youtube.com/watch?v=' + v.id;
    document.title = v.title + ' — हिन्दी न्यूज़';
    document.querySelectorAll('.lv-row').forEach(function (r) {
      r.classList.toggle('current', +r.dataset.i === index);
    });
    if (playerReady && currentId !== v.id) {
      currentId = v.id;
      player.loadVideoById(v.id);
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
        autoplay: 1, mute: 1, rel: 0, modestbranding: 1,
        playsinline: 1, controls: 0, disablekb: 1, fs: 0
      },
      events: {
        onReady: function () {
          playerReady = true;
          player.mute();
          player.playVideo();
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

  /* ---------- sound ---------- */

  function unmuteOnce() {
    if (!muted) return;
    muted = false;
    justUnmuted = true;
    setTimeout(function () { justUnmuted = false; }, 500);
    if (playerReady) { player.unMute(); player.setVolume(100); }
    $('#soundPill').hidden = true;
    $('#muteBtn').textContent = '🔊';
  }
  function toggleMute() {
    if (!playerReady) return;
    if (muted) { unmuteOnce(); }
    else {
      muted = true;
      player.mute();
      $('#soundPill').hidden = false;
      $('#muteBtn').textContent = '🔇';
    }
  }
  document.addEventListener('pointerdown', unmuteOnce);
  document.addEventListener('keydown', unmuteOnce);

  /* ---------- events ---------- */

  $('#taplayer').addEventListener('click', function () {
    if (justUnmuted) { justUnmuted = false; return; }
    if (!playerReady) return;
    if (!muted && player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
    else { unmuteOnce(); player.playVideo(); }
  });
  $('#nextBtn').addEventListener('click', function () { goTo(index + 1); });
  $('#prevBtn').addEventListener('click', function () { goTo(index - 1); });
  $('#muteBtn').addEventListener('click', toggleMute);
  $('#fsBtn').addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  });
  $('#refreshBtn').addEventListener('click', tryLiveRefresh);
  $('#listBtn').addEventListener('click', function () {
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
  $('#chips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) applyFilter(chip.textContent);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'n' || e.key === 'N') goTo(index + 1);
    else if (e.key === 'p' || e.key === 'P') goTo(index - 1);
    else if (e.key === 'm' || e.key === 'M') toggleMute();
    else if (e.key === 'Escape') hideList();
  });

  function hideList() {
    $('#listview').hidden = true;
    document.body.style.overflow = '';
  }

  loadData();
})();
