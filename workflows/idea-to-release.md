# Workflow ایده تا Release

## سیاست زبان
این workflow باید `../system/language-policy.md` را رعایت کند. توضیح، سوال، هشدار، تحلیل و گزارش فارسی است؛ commandها و دارایی‌های نرم‌افزاری انگلیسی می‌مانند.

## فرمان
`/release`

## هدف
اجرای یک فرآیند تکرارپذیر در AStack که توسط Claude Code، OpenAI Codex، ChatGPT یا agentهای آینده قابل‌خواندن باشد.

## مراحل
1. تعریف ایده
2. برنامه‌ریزی
3. طراحی معماری
4. پیاده‌سازی
5. بازبینی
6. تست
7. release

## skillهای مورد استفاده
- feature-planner
- architecture-review
- testing-review
- documentation-review
- deployment-review

## معیار تکمیل
- scope صریح است.
- ریسک معماری و implementation نام‌گذاری شده است.
- تست‌ها مشخص یا پیاده‌سازی شده‌اند.
- documentation و release notes در صورت نیاز به‌روزرسانی شده‌اند.
- پاسخ نهایی شامل تغییرات، verification و residual risk است.
