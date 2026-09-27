/* ==========================================================================
   Bright Smile Clinic — appointment booking

   Saves the appointment to Supabase with status 'pending_payment', then hands
   over to the payment page. The row is only marked 'paid' by the Edge
   Function, after Paymob confirms — never by this file.
   ========================================================================== */

(function () {
   'use strict';

   var ui = window.DentalUI;
   var db = window.DentalDB;

   var form = document.getElementById('appointmentForm');

   if (!form) {
      return;
   }

   /* Appointments can only be booked from now on. */
   var dateField = form.elements.date;

   if (dateField) {
      var now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      dateField.min = now.toISOString().slice(0, 16);
   }

   function formatPrice(piastres) {
      return new Intl.NumberFormat(ui.locale(), {
         style: 'currency',
         currency: 'EGP',
         maximumFractionDigits: 0
      }).format(piastres / 100);
   }

   /* Show the real price next to each service, read from the database. */
   function loadPrices() {
      if (!db.configured) {
         return;
      }

      db.client
         .from('services')
         .select('slug, price_piastres')
         .eq('is_active', true)
         .then(function (result) {
            if (result.error || !result.data) {
               return;
            }

            var select = form.elements.specialist;

            result.data.forEach(function (service) {
               var option = select.querySelector('option[value="' + service.slug + '"]');

               if (option) {
                  option.dataset.price = service.price_piastres;
                  option.textContent = option.textContent.split(' — ')[0] +
                     ' — ' + formatPrice(service.price_piastres);
               }
            });
         });
   }

   form.addEventListener('submit', function (event) {
      event.preventDefault();

      var name = ui.valueOf(form, 'name');
      var date = ui.valueOf(form, 'date');

      if (!name || !ui.valueOf(form, 'email') || !ui.valueOf(form, 'number') || !date) {
         ui.showMessage(form, ui.t('msg.fillAll'), 'error');
         return;
      }

      if (new Date(date) < new Date()) {
         ui.showMessage(form, ui.t('msg.apptPast'), 'error');
         return;
      }

      if (!db.configured) {
         ui.showMessage(
            form,
            'Supabase is not connected yet. Add your project URL and anon key in ' +
            'js/supabase-client.js — see SETUP.md.',
            'error'
         );
         return;
      }

      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;

      window.DentalAuth.requireSession().then(function (session) {
         if (!session) {
            ui.showMessage(form, ui.t('msg.loginRequired'), 'error');
            setTimeout(window.DentalAuth.redirectToLogin, 1400);
            return;
         }

         return db.client
            .from('appointments')
            .insert({
               user_id: session.user.id,
               service_slug: ui.valueOf(form, 'specialist'),
               scheduled_at: new Date(date).toISOString(),
               patient_name: name,
               patient_email: ui.valueOf(form, 'email'),
               patient_phone: ui.valueOf(form, 'number')
            })
            .select('id')
            .single()
            .then(function (result) {
               button.disabled = false;

               if (result.error) {
                  ui.showMessage(form, result.error.message, 'error');
                  return;
               }

               ui.showMessage(form, ui.t('msg.apptSaved'), 'success');

               setTimeout(function () {
                  window.location.href = 'payment.html?appointment=' + result.data.id;
               }, 900);
            });
      }).catch(function (error) {
         button.disabled = false;
         ui.showMessage(form, error.message, 'error');
      });
   });

   loadPrices();
}());
