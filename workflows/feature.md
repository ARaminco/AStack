# Workflow توسعه Feature

## سیاست زبان
این workflow باید `../system/language-policy.md` را رعایت کند. توضیح، سوال، هشدار، تحلیل و گزارش فارسی است؛ commandها و دارایی‌های نرم‌افزاری انگلیسی می‌مانند.

## فرمان
`/plan-feature`

## هدف
اجرای یک فرآیند تکرارپذیر در AStack که توسط Claude Code، OpenAI Codex، ChatGPT یا agentهای آینده قابل‌خواندن باشد.

## مراحل
1. نیازمندی
2. طراحی data
3. برنامه‌ی پیاده‌سازی
4. تست‌ها
5. بازبینی
6. آماده‌سازی انتشار

## skillهای مورد استفاده
- feature-planner
- architecture-review
- api-review
- testing-review

## معیار تکمیل
- scope صریح است.
- ریسک معماری و implementation نام‌گذاری شده است.
- تست‌ها مشخص یا پیاده‌سازی شده‌اند.
- documentation و release notes در صورت نیاز به‌روزرسانی شده‌اند.
- پاسخ نهایی شامل تغییرات، verification و residual risk است.
