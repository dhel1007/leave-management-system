# Agency Leave

An offline employee leave management system for a government agency, built with **React, Tailwind CSS, Express, and SQLite**. The app runs on the same computer as the database and listens only on `127.0.0.1`. The production frontend uses local assets, system fonts, and local API requests; no cloud service, CDN, or internet connection is needed during use.

## Getting started

Requires **Node.js 24 or later** and npm. Dependencies are already installed in this workspace. On another computer, install dependencies once while internet is available, or transfer the complete installed folder with a compatible Node installation.

```powershell
cd C:\Users\Acer\Desktop\Project\leave-management-system
npm install
npm run build
npm start
```

Open **http://127.0.0.1:3001** in a browser. Keep the terminal running while using the app. Stop it with Ctrl+C. After the initial setup, only `npm start` is required; it works offline. On Windows, you can also double-click **Start-Leave.cmd**.

Initial account:

- Username: **admin**
- Temporary password: **ChangeMe!2026**

The first sign-in requires a password change. No demonstration employee records are added to your actual database. To override the initial administrator password, set `ADMIN_PASSWORD` **before the first startup**; use at least 12 characters. This variable does not reset an existing account. Account password resets are available to administrators inside the application.

## First-time agency setup

1. Sign in as administrator and replace the temporary password.
2. Add employees, including their employee number, office, designation, employment type, and appointment date.
3. Review the initial leave types, add your agency's categories, and disable unused ones.
4. Add the applicable holidays and office closures in **Non-working days**.
5. Choose the reporting year in **Leave credits**. Sick and vacation leave accrue automatically after six months of service. Assign entitlements for other types; manual sick/vacation entries remain annual overrides.
6. Create HR and employee logins in **User accounts**. Employee logins must link to an employee record; each employee can link to one account.
7. Employees can apply for themselves. HR and admin can submit on behalf of an employee. A different HR officer or administrator must approve an application.

Accounts require a new password at first sign-in and after an administrator reset. Passwords must contain 12–128 characters.

## Roles

| Capability | Admin | HR | Employee |
| --- | --- | --- | --- |
| View dashboard, calendar, and applications | All agency records | All agency records | Own records |
| Apply for leave | Any active employee | Any active employee | Self |
| Approve and reject applications | Yes | Yes | No |
| Cancel approved applications | Yes | Yes | No |
| Cancel own pending application | Yes | Yes | Yes |
| Add/edit employees and leave types | Yes | Yes | No |
| Assign annual leave credits and non-working days | Yes | Yes | No |
| Create, enable/disable, or reset accounts | Yes | No | No |
| View activity log | Yes | Yes | No |
| Export filtered leave records to CSV and print application | Yes | Yes | Own records |

Access checks are enforced by the backend. Hiding navigation does not grant or revoke permissions. Admin and HR cannot approve an application they submitted, or one linked to their own employee record.

## Included features

- Responsive dashboard with actual counts, monthly approval trends, pending requests, and upcoming leave.
- Employee directory with search, editable details, and active/inactive status.
- Configurable leave types with optional leave credit tracking.
- Per-employee, per-type annual entitlements, approved usage, pending reservations, and available credits.
- Leave applications with working-day and half-day calculations, reasons, statuses, reviewers, and review notes.
- Approval, rejection with a required explanation, cancellation, overlapping-date checks, and overdraw prevention.
- Approved leave calendar, holiday configuration, filtered CSV exports, and printable application summaries.
- Administrator account management, password resets, and forced password changes.
- Persistent local SQLite storage and an activity log for important changes.
- Salted password hashes, expiring server sessions, login attempt limiting, strict cookies, CSRF checks, prepared SQL statements, and atomic credit-related changes.

## Leave calculation rules

These are application rules, not automatic statutory entitlements:

- Monday–Friday are working days. Saturdays, Sundays, and configured non-working dates are excluded.
- A half day must use one working date. Two half-day applications on the same date are treated as overlapping.
- Each application must stay in a single calendar year. Split a request that crosses New Year.
- Sick and vacation leave (VL/SL codes or exact names) automatically earn **1.25 days per completed month after the first six service months** (first credit at month seven), or 15 days per full earning year. Special privilege leave grants 3 days each calendar year without carry-forward. Other tracked types start at zero until HR assigns credits.
- `available = carry-forward + this year's credit − approved days − pending days − future-year reservations`. Pending leave reserves credits. Rejection or cancellation releases those credits. Other leave types retain their annual allocation calculation.
- Editing sick/vacation entitlement sets a manual **annual override**, without replacing carried credits. Existing saved annual totals remain unchanged and take precedence over that year's automatic accrual. Subsequent years continue automatic accrual. For other types, editing entitlement sets the total for that year.
- Leave types without tracking do not require or deduct credits.
- Changing holidays does not recalculate existing applications. Set holidays before submission; cancel and resubmit an affected application if its dates need recalculation.
- Balance tracking cannot be switched on or off for a leave type after that type has applications.
- Monetization, special work schedules, required supporting documents, and eligibility checks other than configured gender rules are not automated. HR should verify eligibility and configure credits according to the agency's approved rules.
- A printed record is an internal application summary, not a prescribed government form.

## Local data and backups

The app automatically creates **data/leave.sqlite** on its first startup. This contains employee records, applications, leave credits, accounts, sessions, and activity history. Data stays on this computer and persists across restarts. The `data/` folder is excluded from Git.

To create a consistent backup, even while the app is running:

```powershell
npm run backup
```

Backups are saved to `data/backups/leave-<timestamp>.sqlite`. Copy backups to a secure offline location. Restrict access to the app folder and backups because they contain personnel records.

To restore:

1. Stop the app and any development server.
2. Preserve a backup of the current database first.
3. Replace `data/leave.sqlite` with the chosen backup.
4. If `data/leave.sqlite-wal` or `data/leave.sqlite-shm` exist, remove those files **only after the app is fully stopped** and the old database has been preserved.
5. Start the app again. Account passwords and records are restored to the backup's state.

The app intentionally does not expose a LAN or public address. Admin, HR, and employee accounts use the local computer. Accessing it from other computers would require a separate deployment and security design.

## Development and validation

```powershell
npm run dev
```

Development frontend: http://127.0.0.1:5173  
Express API: http://127.0.0.1:3001

Vite proxies the local API. The production build is served directly by Express from `dist/`.

```powershell
npm test
npm run test:ui
```

The API tests use isolated databases and test leave calculations, role restrictions, privacy, credit reservations/refunds, approvals, session invalidation, and persistence. The UI test builds the production app and uses an installed **Google Chrome** in headless mode to check admin setup, HR approval, employee access, CSV export, page reload, mobile navigation, and absence of external requests. Browser screenshots and failure traces are written to `test-results/`; tests do not modify your real agency database.

Node 24 uses its built-in SQLite API, which may show an experimental warning on some Node releases. No separate SQLite server or native SQLite dependency needs to be installed.

## Project structure

```text
src/                  React interface and Tailwind stylesheet
server/app.js         Express API, authentication, permissions, and validation
server/db.js          SQLite schema, password hashing, and leave calculations
server/index.js       Local server entry point
server/backup.js      SQLite backup utility
tests/api.test.js     API and persistence tests
tests/ui/             Chrome workflow test
data/                 Local database and backups (generated, ignored)
dist/                 Production frontend (generated, ignored)
```

Optional process environment variables: `PORT` (default 3001), `DB_PATH` (default data/leave.sqlite), `ADMIN_PASSWORD` (initial account only). `.env` files are not loaded automatically.

Implementation references: [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [Tailwind's Vite integration](https://tailwindcss.com/docs/installation/using-vite), and [Express API](https://expressjs.com/en/5x/api/).

## Gender eligibility

Employee details now include Male, Female, Other, and Not specified. Existing employee records default to Not specified until HR updates them; their original details, accounts, leave applications, balances, and history remain intact.

Leave types offer All genders, Female only, or Male only. Names/codes for maternity and paternity suggest Female only and Male only respectively; these are configurable application rules. HR can set eligibility for other types or agency exceptions.

A mismatch or unspecified gender for a restricted type displays a warning before submission. Submission saves an automatically rejected application with its explanation and no credit reservation or deduction. The backend checks the saved employee gender, ignoring any gender sent with the application. Approval also rechecks the current employee and type rule; existing historical decisions are not rewritten.

SQLite adds the new columns automatically on startup without replacing tables. For an explicit backup and verification of all existing records, stop the server and run `npm run migrate`, then `npm start`. The migration command creates a pre-update backup and compares every original column and record after migration.

## Automatic sick and vacation credits

The user-selected policy is 1.25 days per completed month for each of sick and vacation leave, with unused credits carried forward. Accrual excludes the first six completed service months; the first 1.25 days accrue at month seven. Month completion follows the appointment day. An appointment on the 31st completes its first month on the final day of a shorter month; a February 29 appointment uses February 28 in a non-leap year. Partial service months earn zero until completed.

Calculations use the current date in Asia/Manila, so the app works offline without a scheduler. Completed past reporting years use December 31 as their cutoff; current and future years do not receive credits for future service. An employee appointed in the future has no automatic earned credits.

The Employee directory shows available sick and vacation days, automatic credits earned after the six-month waiting period, carry-forward, the current year's credits, and any manual annual override. Select a reporting year to view prior periods. Changing an appointment date recalculates automatic credits immediately without modifying saved manual allocations or leave records.

Existing balance rows are retained as annual overrides. No automatic process overwrites them or inserts duplicate annual grants. Prior approved leave and pending applications reduce carry-forward; approved and pending future requests reserve current carried credits so they cannot be spent twice. Gender-specific leave credit filtering remains in place.

### HR workspace and manual usage

HR officers can submit manual days used for any active, gender-eligible leave type in Workspace. Each entry includes the actual usage date, a source record reference, and an explanation. Only an administrator can approve or reject entries; pending/rejected entries do not affect balances. Approval checks available credits in the usage year and subsequent carried balances. Entries cannot duplicate a pending/approved source reference for the same employee/type or overlap an existing application of that type. All entries and review decisions remain stored and audited.

Leave credits shows Used this year and Total used. Total used combines approved applications and approved manual usage through the selected reporting year. Approved historical usage reduces sick/vacation carry-forward. Untracked leave types retain their usage in Workspace without deducting credits.

Special privilege leave (SPL or its name) always uses a fixed 3-day annual entitlement; saved historical allocations remain in the database but no longer override this policy. Pending and approved usage, including approved manual usage, reduce that year's allocation only. Sick/vacation saved annual overrides remain intact, but become available from the seventh completed service month.

Wellness leave (WEL) is available to all genders with a fixed 5-day allowance each calendar year and no carry-forward. Each application is limited to 3 consecutive **calendar days**, including weekends and holidays in its date range; working-day deductions still follow the normal calendar. Approved applications and manual entries deduct wellness credits; pending applications reserve them. Saved allocations remain stored but cannot override this fixed allowance. Existing wellness requests remain stored; requests exceeding this limit cannot be approved.


Admins can edit or delete manual leave entries in Manual leave entry. Editing preserves approval status and checks credit availability. Deletion removes the entry from active lists and credit calculations while retaining the row. Both require a reason and record the original values in the audit log. Stale edits/deletions are rejected so another review cannot be overwritten.
