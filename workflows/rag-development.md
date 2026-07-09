# Workflow توسعه RAG

## سیاست زبان
این workflow باید `../system/language-policy.md` را رعایت کند. توضیح، سوال، هشدار، تحلیل و گزارش فارسی است؛ commandها و دارایی‌های نرم‌افزاری انگلیسی می‌مانند.

## فرمان
`/rag-review`

## هدف
اجرای یک فرآیند تکرارپذیر در AStack که توسط Claude Code، OpenAI Codex، ChatGPT یا agentهای آینده قابل‌خواندن باشد.

## مراحل
1. تحلیل corpus
2. chunking
3. retrieval
4. generation
5. evals
6. هزینه و latency

## skillهای مورد استفاده
- rag-review
- ai-review
- prompt-review
- cost-review

## معیار تکمیل
- scope صریح است.
- ریسک معماری و implementation نام‌گذاری شده است.
- تست‌ها مشخص یا پیاده‌سازی شده‌اند.
- documentation و release notes در صورت نیاز به‌روزرسانی شده‌اند.
- پاسخ نهایی شامل تغییرات، verification و residual risk است.
