/* ==========================================================================
   Bright Smile Clinic — background tooth
   A stack of Font Awesome tooth glyphs at different depths, fixed behind
   the page and spun by scroll position. A crisp front cap and back cap
   (each hidden via backface-visibility when facing away) bookend a
   color-graded fill so it reads as one solid shape at any angle, without
   the per-slice blur that made a large slice count laggy.
   ========================================================================== */

(function () {
   'use strict';

   var stack = document.getElementById('bg-tooth-3d');
   var front = document.querySelector('.bg-tooth-face--front');
   var back = document.querySelector('.bg-tooth-face--back');

   if (!stack || !front || !back) {
      return;
   }

   var SLICE_COUNT = 28;
   var DEPTH_REM = 14;
   var NEAR_RGB = [0, 109, 175]; // --blue-dark
   var FAR_RGB = [0, 40, 63];

   for (var i = 1; i < SLICE_COUNT - 1; i++) {
      var slice = document.createElement('i');
      slice.className = 'fas fa-tooth';

      var t = i / (SLICE_COUNT - 1);
      var r = Math.round(NEAR_RGB[0] + (FAR_RGB[0] - NEAR_RGB[0]) * t);
      var g = Math.round(NEAR_RGB[1] + (FAR_RGB[1] - NEAR_RGB[1]) * t);
      var b = Math.round(NEAR_RGB[2] + (FAR_RGB[2] - NEAR_RGB[2]) * t);

      slice.style.color = 'rgb(' + r + ',' + g + ',' + b + ')';
      slice.style.transform = 'translateZ(-' + (DEPTH_REM * t) + 'rem)';
      stack.appendChild(slice);
   }

   back.style.transform = 'translateZ(-' + DEPTH_REM + 'rem) rotateY(180deg)';

   var ticking = false;

   function update() {
      var scrollTop = window.scrollY || document.documentElement.scrollTop;
      var scrollable = document.documentElement.scrollHeight - window.innerHeight;
      var fraction = scrollable > 0 ? scrollTop / scrollable : 0;

      stack.style.transform = 'rotateX(18deg) rotateY(' + (fraction * 360) + 'deg)';
      ticking = false;
   }

   window.addEventListener('scroll', function () {
      if (!ticking) {
         window.requestAnimationFrame(update);
         ticking = true;
      }
   }, { passive: true });

   update();
}());
