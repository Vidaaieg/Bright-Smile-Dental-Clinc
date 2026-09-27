/* ==========================================================================
   Bright Smile Clinic — authentication against Supabase Auth

   Replaces the old demo forms that only showed an alert. Passwords are never
   stored or checked here: Supabase hashes them server side.
   ========================================================================== */

(function () {
   'use strict';

   var ui = window.DentalUI;
   var db = window.DentalDB;

   function notConfigured(form) {
      ui.showMessage(
         form,
         'Supabase is not connected yet. Add your project URL and anon key in ' +
         'js/supabase-client.js — see SETUP.md.',
         'error'
      );
   }

   /* ----------------------------------------------------------------------
      Sign up
      ---------------------------------------------------------------------- */

   function initSignUp() {
      var form = document.getElementById('signupForm');

      if (!form) {
         return;
      }

      form.addEventListener('submit', function (event) {
         event.preventDefault();

         var password = ui.valueOf(form, 'password');

         if (password.length < 8) {
            ui.showMessage(form, ui.t('msg.pwShort'), 'error');
            return;
         }

         if (password !== ui.valueOf(form, 'confirmPassword')) {
            ui.showMessage(form, ui.t('msg.pwMismatch'), 'error');
            return;
         }

         if (!db.configured) {
            notConfigured(form);
            return;
         }

         var button = form.querySelector('button[type="submit"]');
         button.disabled = true;

         db.client.auth.signUp({
            email: ui.valueOf(form, 'email'),
            password: password,
            options: {
               // picked up by the handle_new_user() trigger to fill profiles
               data: {
                  first_name: ui.valueOf(form, 'firstName'),
                  last_name: ui.valueOf(form, 'lastName'),
                  phone: ui.valueOf(form, 'number'),
                  address: ui.valueOf(form, 'address')
               }
            }
         }).then(function (result) {
            button.disabled = false;

            if (result.error) {
               ui.showMessage(form, result.error.message, 'error');
               return;
            }

            // With "Confirm email" on (the Supabase default) there is no
            // session yet — the patient has to click the link in their inbox.
            if (result.data.session) {
               ui.showMessage(form, ui.t('msg.signupOk', { name: ui.valueOf(form, 'firstName') }), 'success');
               setTimeout(function () {
                  window.location.href = 'appointment.html';
               }, 1200);
            } else {
               ui.showMessage(form, ui.t('msg.confirmEmail'), 'success');
               form.reset();
            }
         });
      });
   }

   /* ----------------------------------------------------------------------
      Login
      ---------------------------------------------------------------------- */

   function initLogin() {
      var form = document.getElementById('loginForm');

      if (!form) {
         return;
      }

      form.addEventListener('submit', function (event) {
         event.preventDefault();

         var email = ui.valueOf(form, 'email');
         var password = ui.valueOf(form, 'password');

         if (!email || !password) {
            ui.showMessage(form, ui.t('msg.fillBoth'), 'error');
            return;
         }

         if (!db.configured) {
            notConfigured(form);
            return;
         }

         var button = form.querySelector('button[type="submit"]');
         button.disabled = true;

         db.client.auth.signInWithPassword({
            email: email,
            password: password
         }).then(function (result) {
            button.disabled = false;

            if (result.error) {
               // Deliberately vague: never reveal whether the address exists.
               ui.showMessage(form, ui.t('msg.loginFailed'), 'error');
               return;
            }

            ui.showMessage(form, ui.t('msg.loginOk', { name: email }), 'success');

            var next = new URLSearchParams(window.location.search).get('next');
            setTimeout(function () {
               window.location.href = next || 'appointment.html';
            }, 900);
         });
      });
   }

   /* ----------------------------------------------------------------------
      Header: swap Login / Sign Up for Log out once signed in
      ---------------------------------------------------------------------- */

   function renderSession(session) {
      var actions = document.querySelector('.header-actions');

      if (!actions) {
         return;
      }

      var loginLink = actions.querySelector('a[href$="login.html"]');
      var signupLink = actions.querySelector('a[href$="signup.html"]');
      var existing = actions.querySelector('.logout-btn');

      if (session) {
         if (loginLink) { loginLink.hidden = true; }
         if (signupLink) { signupLink.hidden = true; }

         if (!existing) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'link-btn logout-btn';
            button.setAttribute('data-i18n', 'btn.logout');
            button.textContent = ui.t('btn.logout');
            button.addEventListener('click', function () {
               db.client.auth.signOut().then(function () {
                  window.location.href = window.DENTAL_BASE + 'index.html';
               });
            });
            actions.prepend(button);
         }
      } else {
         if (loginLink) { loginLink.hidden = false; }
         if (signupLink) { signupLink.hidden = false; }
         if (existing) { existing.remove(); }
      }
   }

   function initSessionUI() {
      if (!db.configured) {
         return;
      }

      db.client.auth.getSession().then(function (result) {
         renderSession(result.data.session);
      });

      db.client.auth.onAuthStateChange(function (_event, session) {
         renderSession(session);
      });
   }

   /* Shared by booking and payment: send the visitor to log in first. */
   window.DentalAuth = {
      requireSession: function () {
         if (!db.configured) {
            return Promise.resolve(null);
         }

         return db.client.auth.getSession().then(function (result) {
            return result.data.session;
         });
      },
      redirectToLogin: function () {
         var here = window.location.pathname.split('/').pop() + window.location.search;
         window.location.href = 'login.html?next=' + encodeURIComponent(here);
      }
   };

   initSignUp();
   initLogin();
   initSessionUI();
}());
