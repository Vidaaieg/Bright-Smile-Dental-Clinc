/* ==========================================================================
   Bright Smile Clinic — site scripts
   Loaded with `defer` after lang/translations.js, so the DOM and the
   translation table are both ready when this runs.
   ========================================================================== */

(function () {
   'use strict';

   /* ----------------------------------------------------------------------
      Translation
      ---------------------------------------------------------------------- */

   var LANGUAGES = {
      en: { dir: 'ltr', locale: 'en-GB', label: 'EN' },
      ar: { dir: 'rtl', locale: 'ar-EG', label: 'ع' },
      de: { dir: 'ltr', locale: 'de-DE', label: 'DE' },
      ru: { dir: 'ltr', locale: 'ru-RU', label: 'RU' }
   };

   var STORAGE_KEY = 'dentalclinic-lang';
   var dictionaries = window.TRANSLATIONS || {};
   var currentLang = 'en';

   function readStoredLang() {
      var stored;

      try {
         stored = localStorage.getItem(STORAGE_KEY);
      } catch (error) {
         stored = null;
      }

      if (stored && LANGUAGES[stored]) {
         return stored;
      }

      // fall back to the browser's language when we support it
      var browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
      return LANGUAGES[browser] ? browser : 'en';
   }

   /* Looks a key up in the active language, falling back to English so a
      partly translated language never shows an empty page. */
   function t(key, vars) {
      var dict = dictionaries[currentLang] || {};
      var text = dict[key];

      if (text === undefined) {
         text = (dictionaries.en || {})[key];
      }

      if (text === undefined) {
         return '';
      }

      if (vars) {
         Object.keys(vars).forEach(function (name) {
            text = text.split('{' + name + '}').join(vars[name]);
         });
      }

      return text;
   }

   function translateAttribute(attribute, apply) {
      document.querySelectorAll('[' + attribute + ']').forEach(function (element) {
         var text = t(element.getAttribute(attribute));

         if (text) {
            apply(element, text);
         }
      });
   }

   function applyLanguage(lang) {
      if (!LANGUAGES[lang]) {
         lang = 'en';
      }

      currentLang = lang;

      document.documentElement.lang = lang;
      document.documentElement.dir = LANGUAGES[lang].dir;

      translateAttribute('data-i18n', function (element, text) {
         element.textContent = text;
      });

      translateAttribute('data-i18n-placeholder', function (element, text) {
         element.placeholder = text;
      });

      translateAttribute('data-i18n-aria', function (element, text) {
         element.setAttribute('aria-label', text);
      });

      translateAttribute('data-i18n-content', function (element, text) {
         element.setAttribute('content', text);
      });

      document.querySelectorAll('.lang-switch select').forEach(function (select) {
         select.value = lang;
      });

      try {
         localStorage.setItem(STORAGE_KEY, lang);
      } catch (error) {
         /* private browsing — the choice just will not persist */
      }
   }

   function initLanguage() {
      applyLanguage(readStoredLang());

      document.querySelectorAll('.lang-switch select').forEach(function (select) {
         select.addEventListener('change', function () {
            applyLanguage(select.value);
         });
      });
   }

   /* ----------------------------------------------------------------------
      Mobile navigation
      ---------------------------------------------------------------------- */

   function initMenu() {
      var menuBtn = document.getElementById('menu-btn');
      var nav = document.getElementById('nav');

      if (!menuBtn || !nav) {
         return;
      }

      function close() {
         nav.classList.remove('open');
         menuBtn.setAttribute('aria-expanded', 'false');
      }

      menuBtn.addEventListener('click', function () {
         var isOpen = nav.classList.toggle('open');
         menuBtn.setAttribute('aria-expanded', String(isOpen));
      });

      nav.addEventListener('click', function (event) {
         if (event.target.tagName === 'A') {
            close();
         }
      });

      document.addEventListener('click', function (event) {
         if (!event.target.closest('.header')) {
            close();
         }
      });
   }

   /* ----------------------------------------------------------------------
      Highlight the section currently on screen in the nav
      ---------------------------------------------------------------------- */

   function initScrollSpy() {
      var sections = document.querySelectorAll('section[id]');

      if (!sections.length || !window.IntersectionObserver) {
         return;
      }

      var observer = new IntersectionObserver(function (entries) {
         entries.forEach(function (entry) {
            if (!entry.isIntersecting) {
               return;
            }

            var link = document.querySelector('.nav a[href$="#' + entry.target.id + '"]');

            if (link) {
               document.querySelectorAll('.nav a.current').forEach(function (active) {
                  active.classList.remove('current');
                  active.removeAttribute('aria-current');
               });
               link.classList.add('current');
               link.setAttribute('aria-current', 'true');
            }
         });
      }, { rootMargin: '-40% 0px -55% 0px' });

      sections.forEach(function (section) {
         observer.observe(section);
      });
   }

   /* ----------------------------------------------------------------------
      Inline form feedback (replaces alert() popups)
      ---------------------------------------------------------------------- */

   function showMessage(form, text, type) {
      var message = form.querySelector('.form-message');

      if (!message) {
         message = document.createElement('div');
         message.setAttribute('role', 'status');
         form.prepend(message);
      }

      message.textContent = text;
      message.className = 'form-message form-message--' + type;
      message.scrollIntoView({ behavior: 'smooth', block: 'center' });
   }

   function valueOf(form, name) {
      var field = form.elements[name];
      return field ? field.value.trim() : '';
   }

   /* ----------------------------------------------------------------------
      Contact
      ---------------------------------------------------------------------- */

   function initContactForm() {
      var form = document.getElementById('contactForm');

      if (!form) {
         return;
      }

      form.addEventListener('submit', function (event) {
         event.preventDefault();

         var firstName = valueOf(form, 'firstName');
         var lastName = valueOf(form, 'lastName');

         if (!firstName || !lastName || !valueOf(form, 'email') ||
             !valueOf(form, 'phone') || !valueOf(form, 'message')) {
            showMessage(form, t('msg.fillAll'), 'error');
            return;
         }

         showMessage(form, t('msg.contactOk', { name: firstName + ' ' + lastName }), 'success');
         form.reset();
      });
   }

   /* ----------------------------------------------------------------------
      Footer year
      ---------------------------------------------------------------------- */

   function initYear() {
      document.querySelectorAll('[data-year]').forEach(function (element) {
         element.textContent = String(new Date().getFullYear());
      });
   }

   /* ----------------------------------------------------------------------
      Shared helpers for the Supabase-backed scripts (auth, booking, payment)
      ---------------------------------------------------------------------- */

   window.DentalUI = {
      t: t,
      showMessage: showMessage,
      valueOf: valueOf,
      locale: function () {
         return LANGUAGES[currentLang].locale;
      },
      lang: function () {
         return currentLang;
      }
   };

   initLanguage();
   initMenu();
   initScrollSpy();
   initContactForm();
   initYear();
}());
