# SafePrompt - Secure Prompt Enhancer for VS Code

SafePrompt is a lightweight VS Code extension that helps developers **write safer prompts** for AI coding assistants.  
It detects insecure coding patterns (like hardcoded secrets, missing authorization) and **enhances user prompts** by automatically suggesting security best practices.

---

## Features
- **Security Warnings**
  - Detects hardcoded API keys, tokens, and secrets.
  - Warns about missing authentication/authorization in routes.
  - Provides inline diagnostics inside VS Code.

- **Prompt Enhancement**
  - Enhances developer prompts in real-time with security best practices.
  - Example:
    ```
    PROMPT: Create login website
    ENHANCED: Create login website with authentication, input validation, role-based authorization, and CSRF protection
    ```

  - **LLM Powered Suggestions**
  - Uses NVIDIA NIM (Llama 3.1 Nemotron-70B) via API for dynamic prompt enhancements.
  - Configurable through `.env` file for API credentials.
