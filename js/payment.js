/* ==========================================================================
   Bright Smile Clinic — payment page

   This file never sees a card number. It asks the `create-payment` Edge
   Function for a Paymob payment key, then loads Paymob's own iframe, which
   is where the patient types their card details.

   The amount is NOT sent from here. The Edge Function reads it from the
   services table, so editing this page cannot change what is charged.
   ========================================================================== */

(function () {
   'use strict';

   var ui = window.DentalUI;
   var db = window.DentalDB;

   var card = document.getElementById('payCard');

   if (!card) {
      return;
   }

   var statusBox = document.getElementById('payStatus');
   var summary = document.getElementById('paySummary');
   var payButton = document.getElementById('payButton');
   var frameWrap = document.getElementById('payFrame');
   var frame = document.getElementById('paymobFrame');

   var appointmentId = new URLSearchParams(window.location.search).get('appointment');

   function setStatus(messageKey, icon, isError) {
      statusBox.hidden = false;
      statusBox.className = 'pay-status' + (isError ? ' pay-status--error' : '');
      statusBox.innerHTML = '<i class="fas ' + icon + '"></i> <span>' + ui.t(messageKey) + '</span>';
   }

   function setStatusText(text, icon, isError) {
      statusBox.hidden = false;
      statusBox.className = 'pay-status' + (isError ? ' pay-status--error' : '');
      statusBox.innerHTML = '<i class="fas ' + icon + '"></i> <span></span>';
      statusBox.querySelector('span').textContent = text;
   }

   function formatPrice(piastres) {
      return new Intl.NumberFormat(ui.locale(), {
         style: 'currency',
         currency: 'EGP',
         maximumFractionDigits: 2
      }).format(piastres / 100);
   }

   function serviceName(service) {
      var lang = ui.lang();
      return service['name_' + lang] || service.name_en;
   }

   function showAppointment(appointment) {
      document.getElementById('paySummaryService').textContent = serviceName(appointment.services);
      document.getElementById('paySummaryWhen').textContent =
         new Date(appointment.scheduled_at).toLocaleString(ui.locale());
      document.getElementById('paySummaryPatient').textContent = appointment.patient_name;
      document.getElementById('paySummaryTotal').textContent =
         formatPrice(appointment.services.price_piastres);

      summary.hidden = false;
      statusBox.hidden = true;

      if (appointment.status === 'paid') {
         setStatus('pay.alreadyPaid', 'fa-circle-check');
         return;
      }

      payButton.hidden = false;
   }

   function loadAppointment() {
      if (!db.configured) {
         setStatusText(
            'Supabase is not connected yet. Add your project URL and anon key in ' +
            'js/supabase-client.js — see SETUP.md.',
            'fa-triangle-exclamation',
            true
         );
         return;
      }

      if (!appointmentId) {
         setStatus('pay.noAppointment', 'fa-triangle-exclamation', true);
         return;
      }

      window.DentalAuth.requireSession().then(function (session) {
         if (!session) {
            setStatus('msg.loginRequired', 'fa-triangle-exclamation', true);
            setTimeout(window.DentalAuth.redirectToLogin, 1400);
            return;
         }

         // RLS makes sure this only ever returns the patient's own appointment.
         return db.client
            .from('appointments')
            .select('id, scheduled_at, patient_name, status, services(slug, name_en, name_ar, name_de, name_ru, price_piastres)')
            .eq('id', appointmentId)
            .single()
            .then(function (result) {
               if (result.error || !result.data) {
                  setStatus('pay.noAppointment', 'fa-triangle-exclamation', true);
                  return;
               }

               showAppointment(result.data);
            });
      });
   }

   payButton.addEventListener('click', function () {
      payButton.disabled = true;
      setStatus('pay.preparing', 'fa-circle-notch fa-spin');

      db.client.functions.invoke('create-payment', {
         body: { appointment_id: appointmentId }
      }).then(function (result) {
         payButton.disabled = false;

         if (result.error) {
            setStatusText(result.error.message, 'fa-triangle-exclamation', true);
            return;
         }

         if (!result.data || !result.data.iframe_url) {
            setStatus('pay.failed', 'fa-triangle-exclamation', true);
            return;
         }

         // Hand over to Paymob. Everything card-related happens in there.
         statusBox.hidden = true;
         payButton.hidden = true;
         frame.src = result.data.iframe_url;
         frameWrap.hidden = false;
         frameWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
   });

   loadAppointment();
}());
