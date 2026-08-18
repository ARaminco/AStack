# AStack Enterprise

**زبان‌ها:** [English](README.md) · فارسی · [العربية](README.ar.md) · [Türkçe](README.tr.md) — **مستندات:** [فهرست مستندات](documentation/README.md)

AStack Enterprise یک سیستم‌عامل هوش مصنوعی ماژولار است که در درجه اول داخل Claude Code اجرا می‌شود و با OpenAI Codex، ChatGPT و رانتایم‌های آینده نیز سازگار است. این سیستم هر نوع کاری را مدیریت می‌کند — توسعه نرم‌افزار، پرونده‌های حقوقی، امور مالی، مالیاتی، حسابداری، بازاریابی، عملیات، منابع انسانی، تحقیق و استراتژی کسب‌وکار — با تشکیل تیم‌های تخصصی، ساخت ایجنت‌ها و تفویض مأموریت‌های زمان‌بندی‌شده زیر نظر لایه رهبری.

## رانتایم
- رانتایم اصلی: Claude Code ([نحوه کار با AStack](documentation/Claude-Code.md))
- ارتباط با مالک: فارسی — کد و مستندات فنی: انگلیسی
- معماری: لایه‌ای، توسعه‌پذیر با پلاگین، مستقل از ارائه‌دهنده، دامنه‌آگاه ([جزئیات](documentation/Architecture.md))

## شروع سریع
```bash
npm test
node bin/astack.mjs doctor
node bin/astack.mjs domain detect "اظهارنامه مالیات ارزش افزوده"
node bin/astack.mjs lead plan "پرونده حقوقی قرارداد ملکی"
node bin/astack.mjs lead team "پرونده حقوقی قرارداد ملکی" --name legal-case-team
node bin/astack.mjs project init "Contract Dispute" --template legal-case
node bin/astack.mjs lead delegate contract-dispute --team legal-case-team
node bin/astack.mjs agent run-due
node bin/astack.mjs lead standup
```
ادامه در [راهنمای نصب](documentation/Installation.md) و [مرجع فرمان‌ها](documentation/API.md).

## دامنه‌های کاری
رجیستری دامنه هر درخواست را — فارسی یا انگلیسی — به دپارتمان‌ها، ورک‌فلو و نقشه تیم مناسب هدایت می‌کند: نرم‌افزار، حقوقی، مالی، حسابداری، مالیاتی، بازاریابی، عملیات، منابع انسانی، تحقیق و کسب‌وکار. ببینید: [دپارتمان‌ها](documentation/Departments.md) و [نقش‌ها](documentation/Roles.md) (۳۳ دپارتمان، ۲۱۹ نقش تخصصی).

## تیم‌ها، ایجنت‌ها و رهبری
- `astack team` — تشکیل و مدیریت تیم‌های تخصصی از روی نقشه هر دامنه
- `astack agent` — ساخت ایجنت، زمان‌بندی مأموریت‌های یک‌باره یا تکرارشونده، صدور دستور کار و ثبت گزارش
- `astack lead` — لایه رهبری: برنامه‌ریزی، تشکیل تیم، تفویض کارهای پروژه، گزارش وضعیت و بازبینی خروجی‌ها

راهنمای کامل: [دامنه‌ها، تیم‌ها، ایجنت‌ها و رهبری](documentation/Orchestration.md).

## تحویل پروژه
موتور تحویل، پروژه‌ها را مانند یک تیم تحویل حرفه‌ای مدیریت می‌کند: چرخه مرحله‌بندی‌شده با دروازه‌های عبور، تخمین PERT، بک‌لاگ رتبه‌بندی‌شده با WSJF، بورد کانبان با محدودیت WIP، برنامه‌ریزی اسپرینت بر اساس سرعت واقعی، دفتر ریسک امتیازدهی‌شده، پیش‌بینی اتمام مونت‌کارلو، مدیریت ارزش کسب‌شده (EVM)، امتیاز سلامت شفاف و پیشنهاد اقدام بعدی. قالب‌های آماده برای نرم‌افزار، قابلیت هوش مصنوعی، MVP استارتاپ، کمپین بازاریابی، پرونده حقوقی، اظهارنامه مالیاتی، بستن حساب و حسابرسی مالی. ببینید: [مدیریت پروژه](documentation/Project-Management.md).

## ارتقای هسته
پروژه‌هایی که AStack را درون خود دارند با `astack upgrade` خودشان را به‌روز می‌کنند. نصب‌های قدیمی‌تر که موتور ارتقا را ندارند، فایل تکِ `scripts/astack-upgrade.mjs` را داخل پروژه کپی و یک بار اجرا می‌کنند — آخرین هسته را می‌گیرد و با منطق جدید ارتقا می‌دهد؛ در حالی که `.astack/`، `memory/`، پلاگین‌ها، knowledge packها و هر مسیر ثبت‌شده در `upgrade.keep` دست‌نخورده می‌مانند. ببینید: [ارتقای هسته](documentation/Upgrade.md) و [راهنمای مهاجرت](documentation/Migration-Guide.md).

## مستندات
مجموعه کامل در [`documentation/`](documentation/README.md) قرار دارد — مفاهیم، عملیات، راهنمای توسعه، امنیت و راهنمای کامل فارسی مالک ([fa-guide.html](documentation/fa-guide.html)).
