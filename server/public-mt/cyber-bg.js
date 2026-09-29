/*
 * VEDETTA — sfondo animato "cyber" in stile Tesys.
 * Griglia HUD sottile + rete di particelle luminose collegate + triangoli
 * del logo che derivano lentamente + un paio di bagliori pulsanti.
 * Pensato per essere visibile attraverso i pannelli in vetro (backdrop-filter).
 */
(function () {
  "use strict";

  var canvas = document.getElementById("cyber-bg");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");

  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var TEAL = "90,186,147"; // rgb del verde-teal Tesys (#5aba93)
  var LINK_DIST = 160;

  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0, H = 0;
  var particles = [];
  var triangles = [];
  var glows = [];
  var GRID = 46;
  var t0 = Date.now();
  var rafId = null;

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    initScene();
  }

  function initScene() {
    var area = W * H;
    var count = Math.max(28, Math.min(110, Math.round(area / 15000)));
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.24,
        vy: (Math.random() - 0.5) * 0.24,
        r: 1.5 + Math.random() * 2.1,
        tw: Math.random() * Math.PI * 2 // fase di "respiro" (twinkle)
      });
    }
    var triCount = W < 700 ? 3 : 5;
    triangles = [];
    for (var j = 0; j < triCount; j++) {
      triangles.push(makeTriangle(true));
    }
    glows = [
      { x: W * 0.18, y: H * 0.20, r: Math.max(W, H) * 0.38, spd: 0.00011, ph: 0 },
      { x: W * 0.85, y: H * 0.15, r: Math.max(W, H) * 0.30, spd: 0.00016, ph: 1.4 },
      { x: W * 0.75, y: H * 0.85, r: Math.max(W, H) * 0.36, spd: 0.00014, ph: 2.1 },
      { x: W * 0.10, y: H * 0.80, r: Math.max(W, H) * 0.28, spd: 0.00018, ph: 3.6 }
    ];
  }

  function makeTriangle(randomY) {
    var size = 90 + Math.random() * 170;
    return {
      x: Math.random() * W,
      y: randomY ? Math.random() * H : H + size,
      size: size,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.0006,
      vy: -0.05 - Math.random() * 0.08,
      alpha: 0.10 + Math.random() * 0.09
    };
  }

  function drawGrid(now) {
    var offset = (now * 0.006) % GRID;
    ctx.strokeStyle = "rgba(" + TEAL + ",0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = -GRID + offset; x < W + GRID; x += GRID) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (var y = -GRID + offset; y < H + GRID; y += GRID) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
  }

  function drawGlows(now) {
    for (var i = 0; i < glows.length; i++) {
      var g = glows[i];
      var pulse = 0.5 + 0.5 * Math.sin(now * g.spd + g.ph);
      var r = g.r * (0.85 + 0.15 * pulse);
      var grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r);
      grad.addColorStop(0, "rgba(" + TEAL + "," + (0.14 + 0.07 * pulse) + ")");
      grad.addColorStop(1, "rgba(" + TEAL + ",0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawTriangle(t) {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.rot);
    ctx.strokeStyle = "rgba(" + TEAL + "," + t.alpha + ")";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    var s = t.size;
    ctx.beginPath();
    ctx.moveTo(-s * 0.55, -s * 0.35);
    ctx.lineTo(s * 0.55, -s * 0.35);
    ctx.lineTo(0, s * 0.62);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawFrame() {
    var now = Date.now() - t0;
    ctx.clearRect(0, 0, W, H);

    drawGlows(now);
    drawGrid(now);

    for (var t = 0; t < triangles.length; t++) {
      var tr = triangles[t];
      tr.rot += tr.vrot;
      tr.y += tr.vy;
      if (tr.y < -tr.size) triangles[t] = makeTriangle(false);
      drawTriangle(tr);
    }

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }

    ctx.lineWidth = 1;
    for (var a = 0; a < particles.length; a++) {
      for (var b = a + 1; b < particles.length; b++) {
        var p1 = particles[a], p2 = particles[b];
        var dx = p1.x - p2.x, dy = p1.y - p2.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < LINK_DIST) {
          var alpha = (1 - d / LINK_DIST) * 0.28;
          ctx.strokeStyle = "rgba(" + TEAL + "," + alpha + ")";
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    }

    for (var k = 0; k < particles.length; k++) {
      var pp = particles[k];
      var twinkle = 0.65 + 0.35 * Math.sin(now * 0.0016 + pp.tw);
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, pp.r * twinkle, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + TEAL + "," + (0.7 * twinkle) + ")";
      ctx.shadowColor = "rgba(" + TEAL + ",0.9)";
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function loop() {
    drawFrame();
    if (!reduceMotion && !document.hidden) {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
    }
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !reduceMotion && rafId === null) {
      rafId = requestAnimationFrame(loop);
    }
  });

  resize();
  loop(); // primo frame sempre disegnato (anche con "riduci le animazioni" attivo)
})();
