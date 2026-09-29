/*
 * QR Code generator (byte mode) — self-contained, no dependencies, no network.
 * Adapted from Project Nayuki's QR Code generator library (MIT License).
 * API:  QRCode.encode(text, eccLevel) -> { size, get(x,y) }
 *       eccLevel: "L" | "M" | "Q" | "H" (default "M")
 */
"use strict";
var QRCode = (function () {

  // ---------- GF(256) Reed-Solomon ----------
  function reedSolomonComputeDivisor(degree) {
    if (degree < 1 || degree > 255) throw "Degree out of range";
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1); // Monomial x^0
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }
  function reedSolomonComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) {
        result[i] ^= reedSolomonMultiply(coef, factor);
      });
    });
    return result;
  }
  function reedSolomonMultiply(x, y) {
    if (x >> 8 != 0 || y >> 8 != 0) throw "Byte out of range";
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  // ---------- Tables ----------
  var ECC_CODEWORDS_PER_BLOCK = [
    // Ver: 1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
  ];
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var ECL_FORMAT = { L: 1, M: 0, Q: 3, H: 2 }; // format bits value per level

  var MIN_VERSION = 1, MAX_VERSION = 40;
  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, eclKey) {
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[ECL[eclKey]][ver]
      * NUM_ERROR_CORRECTION_BLOCKS[ECL[eclKey]][ver];
  }

  // ---------- QrCode ----------
  function QrCode(version, eclKey, dataCodewords) {
    this.version = version;
    this.size = version * 4 + 17;
    this.eclKey = eclKey;
    var N = this.size;
    this.modules = [];
    this.isFunction = [];
    for (var i = 0; i < N; i++) {
      this.modules.push(new Array(N).fill(false));
      this.isFunction.push(new Array(N).fill(false));
    }
    this.drawFunctionPatterns();
    var allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);

    // choose best mask
    var minPenalty = Infinity, bestMask = 0;
    for (var m = 0; m < 8; m++) {
      this.applyMask(m);
      this.drawFormatBits(m);
      var p = this.getPenaltyScore();
      if (p < minPenalty) { minPenalty = p; bestMask = m; }
      this.applyMask(m); // undo
    }
    this.applyMask(bestMask);
    this.drawFormatBits(bestMask);
    this.mask = bestMask;
  }

  QrCode.prototype.get = function (x, y) {
    return (0 <= x && x < this.size && 0 <= y && y < this.size) && this.modules[y][x];
  };

  QrCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.drawFunctionPatterns = function () {
    var N = this.size;
    // timing patterns
    for (var i = 0; i < N; i++) {
      this.setFunctionModule(6, i, i % 2 == 0);
      this.setFunctionModule(i, 6, i % 2 == 0);
    }
    // finder patterns
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(N - 4, 3);
    this.drawFinderPattern(3, N - 4);
    // alignment patterns
    var alignPos = this.getAlignmentPatternPositions();
    var n = alignPos.length;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (!((i == 0 && j == 0) || (i == 0 && j == n - 1) || (i == n - 1 && j == 0)))
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }
    // format and version (dummy now, real bits later)
    this.drawFormatBits(0);
    this.drawVersion();
  };

  QrCode.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
          this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
      }
    }
  };

  QrCode.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
  };

  QrCode.prototype.getAlignmentPatternPositions = function () {
    if (this.version == 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = (this.version == 32) ? 26 :
      Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = this.size - 7; result.length < numAlign; pos -= step)
      result.splice(1, 0, pos);
    return result;
  };

  QrCode.prototype.drawFormatBits = function (mask) {
    var data = (ECL_FORMAT[this.eclKey] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    // first copy
    for (var i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (var i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
    // second copy
    var N = this.size;
    for (var i = 0; i < 8; i++) this.setFunctionModule(N - 1 - i, 8, getBit(bits, i));
    for (var i = 8; i < 15; i++) this.setFunctionModule(8, N - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, N - 8, true); // always dark
  };

  QrCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.version << 12) | rem;
    for (var i = 0; i < 18; i++) {
      var bit = getBit(bits, i);
      var a = this.size - 11 + i % 3, b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QrCode.prototype.addEccAndInterleave = function (data) {
    var ver = this.version, eclKey = this.eclKey;
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ECL[eclKey]][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ECL[eclKey]][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = reedSolomonComputeDivisor(blockEccLen);
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
          result.push(blocks[j][i]);
      }
    }
    return result;
  };

  QrCode.prototype.drawCodewords = function (data) {
    var N = this.size, i = 0;
    for (var right = N - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (var vert = 0; vert < N; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) == 0;
          var y = upward ? N - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  QrCode.prototype.applyMask = function (mask) {
    var N = this.size;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        if (this.isFunction[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 == 0; break;
          case 1: invert = y % 2 == 0; break;
          case 2: invert = x % 3 == 0; break;
          case 3: invert = (x + y) % 3 == 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0; break;
          case 5: invert = x * y % 2 + x * y % 3 == 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function () {
    var N = this.size, result = 0, m = this.modules;
    // rows
    for (var y = 0; y < N; y++) {
      var runColor = false, runX = 0;
      var runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (var x = 0; x < N; x++) {
        if (m[y][x] == runColor) {
          runX++;
          if (runX == 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = m[y][x]; runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    // cols
    for (var x = 0; x < N; x++) {
      var runColor = false, runY = 0;
      var runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (var y = 0; y < N; y++) {
        if (m[y][x] == runColor) {
          runY++;
          if (runY == 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = m[y][x]; runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }
    // 2x2 blocks
    for (var y = 0; y < N - 1; y++) {
      for (var x = 0; x < N - 1; x++) {
        var c = m[y][x];
        if (c == m[y][x + 1] && c == m[y + 1][x] && c == m[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    // dark ratio
    var dark = 0;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) if (m[y][x]) dark++;
    var total = N * N;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  };

  QrCode.prototype.finderPenaltyCountPatterns = function (rh) {
    var n = rh[1];
    var core = n > 0 && rh[2] == n && rh[3] == n * 3 && rh[4] == n && rh[5] == n;
    return (core && rh[0] >= n * 4 && rh[6] >= n ? 1 : 0)
      + (core && rh[6] >= n * 4 && rh[0] >= n ? 1 : 0);
  };
  QrCode.prototype.finderPenaltyTerminateAndCount = function (currentRunColor, currentRunLength, rh) {
    if (currentRunColor) { this.finderPenaltyAddHistory(currentRunLength, rh); currentRunLength = 0; }
    currentRunLength += this.size;
    this.finderPenaltyAddHistory(currentRunLength, rh);
    return this.finderPenaltyCountPatterns(rh);
  };
  QrCode.prototype.finderPenaltyAddHistory = function (currentRunLength, rh) {
    if (rh[0] == 0) currentRunLength += this.size;
    rh.pop(); rh.unshift(currentRunLength);
  };

  function getBit(x, i) { return ((x >>> i) & 1) != 0; }

  // ---------- Encoding (byte mode) ----------
  function toUtf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return out;
  }

  function encode(text, eclKey) {
    eclKey = eclKey || "M";
    if (ECL[eclKey] === undefined) eclKey = "M";
    var bytes = toUtf8Bytes(text);

    // choose smallest version that fits (byte mode)
    var version = -1, dataCapacityBits = 0, ccLenBits = 0;
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      var cap = getNumDataCodewords(v, eclKey) * 8;
      var lenBits = (v <= 9) ? 8 : 16; // byte mode char-count bits
      var need = 4 + lenBits + bytes.length * 8;
      if (need <= cap) { version = v; dataCapacityBits = cap; ccLenBits = lenBits; break; }
    }
    if (version < 0) throw "Data too long for QR (max version exceeded)";

    // build bit stream
    var bb = [];
    function appendBits(val, len) {
      for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
    }
    appendBits(0x4, 4);            // byte mode indicator
    appendBits(bytes.length, ccLenBits);
    bytes.forEach(function (b) { appendBits(b, 8); });

    // terminator + padding
    appendBits(0, Math.min(4, dataCapacityBits - bb.length));
    while (bb.length % 8 != 0) bb.push(0);
    for (var pad = 0xEC; bb.length < dataCapacityBits; pad ^= 0xEC ^ 0x11)
      appendBits(pad, 8);

    // pack into bytes
    var dataCodewords = [];
    for (var i = 0; i < bb.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb[i + j];
      dataCodewords.push(b);
    }

    var qr = new QrCode(version, eclKey, dataCodewords);
    return {
      size: qr.size,
      version: qr.version,
      get: function (x, y) { return qr.get(x, y); }
    };
  }

  return { encode: encode };
})();

if (typeof module !== "undefined" && module.exports) module.exports = QRCode;
