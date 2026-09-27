/* ==========================================================================
   Bright Smile Clinic — Meta Pixel, behind a consent gate

   HOW TO CONFIGURE
   Meta Events Manager → Data Sources → your pixel → copy the Pixel ID
   (a 15–16 digit number) into META_PIXEL_ID below.

   ---------------------------------------------------------------------------
   READ THIS BEFORE TURNING IT ON
   ---------------------------------------------------------------------------
   A dental clinic is a health provider, and what a visitor looks at here can
   reveal something about their health. Two rules are built into this file and
   should stay built in:

   1. NOTHING LOADS UNTIL THE VISITOR AGREES. Under GDPR (and Egypt's PDPL)
      advertising trackers need opt-in consent, given freely, before the
      script runs — not a banner that tracks you while you read it.

   2. THE PIXEL NEVER RUNS ON PRIVATE PAGES. Booking, payment and account
      pages are excluded outright, and no service name, price, patient name
      or appointment detail is ever sent to Meta. Sending "this person booked
      a root canal" to an ad platform is exactly the kind of disclosure that
      has cost other clinics real money in regulatory fines.

   If Meta's own Conversions API or "advanced matching" is added later, keep
   both rules. They are the difference between marketing and a data breach.
   ========================================================================== */

window.META_PIXEL_ID = 'YOUR_META_PIXEL_ID';

(function () {
   'use strict';

   var STORAGE_KEY = 'dentalclinic-consent';

   /* Pages that must never be tracked, matched against the URL path. */
   var PRIVATE_PAGES = ['payment', 'appointment', 'login', 'signup'];

   function isPrivatePage() {
      var path = window.location.pathname.toLowerCase();

      return PRIVATE_PAGES.some(function (name) {
         return path.indexOf(name) !== -1;
      });
   }

   function readConsent() {
      try {
         return localStorage.getItem(STORAGE_KEY);
      } catch (error) {
         return null;
      }
   }

   function saveConsent(value) {
      try {
         localStorage.setItem(STORAGE_KEY, value);
      } catch (error) {
         /* private browsing — the banner will ask again next visit */
      }
   }

   /* ----------------------------------------------------------------------
      The pixel itself — only ever called after an explicit "accept"
      ---------------------------------------------------------------------- */

   function loadMetaPixel() {
      var pixelId = window.META_PIXEL_ID;

      if (!pixelId || pixelId.indexOf('YOUR_') === 0) {
         console.info('Bright Smile Clinic: no Meta Pixel ID set, skipping analytics.');
         return;
      }

      if (isPrivatePage() || window.fbq) {
         return;
      }

      /* Meta's standard loader snippet. */
      /* eslint-disable */
      !function (f, b, e, v, n, t, s) {
         if (f.fbq) return; n = f.fbq = function () {
            n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
         };
         if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
         n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
         s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */

      window.fbq('init', pixelId);

      // PageView only. No parameters — the URL alone is enough for Meta, and
      // anything we add risks describing the visitor's health.
      window.fbq('track', 'PageView');
   }

   /* ----------------------------------------------------------------------
      Consent banner
      ---------------------------------------------------------------------- */

   function t(key, fallback) {
      var translate = window.DentalUI && window.DentalUI.t;
      return (translate && translate(key)) || fallback;
   }

   function buildBanner() {
      var banner = document.createElement('div');
      banner.className = 'consent-banner';
      banner.setAttribute('role', 'dialog');
      banner.setAttribute('aria-live', 'polite');
      banner.setAttribute('aria-label', t('consent.title', 'Cookies'));

      var text = document.createElement('p');
      text.setAttribute('data-i18n', 'consent.text');
      text.textContent = t(
         'consent.text',
         'We would like to use Meta advertising cookies to measure how well our ads work. ' +
         'They are optional — the site works exactly the same if you decline. ' +
         'We never share anything about your treatment or appointments.'
      );

      var actions = document.createElement('div');
      actions.className = 'consent-actions';

      var decline = document.createElement('button');
      decline.type = 'button';
      decline.className = 'consent-decline';
      decline.setAttribute('data-i18n', 'consent.decline');
      decline.textContent = t('consent.decline', 'Decline');

      var accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'link-btn';
      accept.setAttribute('data-i18n', 'consent.accept');
      accept.textContent = t('consent.accept', 'Accept');

      decline.addEventListener('click', function () {
         saveConsent('declined');
         banner.remove();
      });

      accept.addEventListener('click', function () {
         saveConsent('granted');
         banner.remove();
         loadMetaPixel();
      });

      actions.append(decline, accept);
      banner.append(text, actions);

      return banner;
   }

   function init() {
      var consent = readConsent();

      if (consent === 'granted') {
         loadMetaPixel();
         return;
      }

      // Already answered "no", or on a page we would not track anyway.
      if (consent === 'declined' || isPrivatePage()) {
         return;
      }

      document.body.appendChild(buildBanner());
   }

   /* Exposed so a "cookie settings" link can reopen the choice later —
      withdrawing consent has to be as easy as giving it. */
   window.DentalConsent = {
      reset: function () {
         saveConsent('');
         window.location.reload();
      },
      status: readConsent
   };

   init();
}());
