DICEWARS BOOKING APP v4

Included:
- Friday-only bookings
- 8 tables, capacity 2 each
- 4pm-8:30pm, one-hour slots (4pm, 5pm, 6pm, 7pm)
- Persistent JSON booking storage
- Customer booking lookup/cancellation by reference + email
- Staff login session instead of sending the PIN with every request
- Rate limits and basic security headers
- Privacy starter page

RUN
1. Install Node.js 18+.
2. Set a strong staff PIN:
   Linux/macOS: ADMIN_PIN='use-a-long-random-pin' npm start
   Windows PowerShell: $env:ADMIN_PIN='use-a-long-random-pin'; npm start
3. Open http://localhost:3000

IMPORTANT BEFORE PUBLIC LAUNCH
- Host behind HTTPS.
- Move bookings to a managed database for production/multiple server instances.
- Configure secure staff authentication and secret storage.
- Add a real transactional email provider for confirmations/cancellation notices.
- Review and publish a final privacy notice and terms.
- Configure backups and a data-retention policy.
