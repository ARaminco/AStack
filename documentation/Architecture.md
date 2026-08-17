# AStack Enterprise Architecture

AStack Enterprise uses layered architecture: Core, Runtime, Orchestrator, Domains, Departments, Roles, Teams, Agents, Providers, Knowledge Packs, Plugins, Memory Engine, Workflow Engine, Delivery Engine, Team Engine, Agent Engine, Upgrade Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and optional Telemetry.

Departments and agents never communicate directly. The Orchestrator coordinates all work through the Leadership layer.

The Domain Registry classifies every engagement (software, legal, finance, accounting, tax, marketing, operations, hr, research, business) from Persian or English intent, and maps it to departments, a default workflow, and a team blueprint.

The Team Engine assembles cross-functional teams from domain blueprints. The Agent Engine creates agents, schedules one-off or recurring missions, dispatches them as work orders, and records reports. The Leadership module ties them together: propose, form team, delegate project work, standup, review.

The Delivery Engine manages project lifecycle, sprints, risks, forecasting, and health; the Orchestrator surfaces the active project state, active teams, due missions, and pending reviews in every review answer.

The Upgrade Engine keeps embedded cores current from the canonical repository while preserving owner data and customizations.
