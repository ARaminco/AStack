# AStack Enterprise Architecture

AStack Enterprise uses layered architecture: Core, Runtime, Orchestrator, Departments, Roles, Providers, Knowledge Packs, Plugins, Memory Engine, Workflow Engine, Delivery Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and optional Telemetry.

Departments never communicate directly. The Orchestrator coordinates all work.

The Delivery Engine manages project lifecycle, sprints, risks, forecasting, and health; the Orchestrator surfaces the active project state in every review answer.
