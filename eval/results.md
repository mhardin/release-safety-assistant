# Triage evaluation

Run 2026-10-21T20:04:18.837Z against `release-safety-assistant.matthew-hardin.workers.dev`, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, 18 cases.
Median end-to-end latency 6.8s.

| | Cause correct | Action correct |
|---|---|---|
| Rules only | 16/18 (89%) | 17/18 (94%) |
| Full (rules + llama-3.3-70b-instruct-fp8-fast) | 17/18 (94%) | 18/18 (100%) |

| Case | Note | Expected | Rules only | Full |
|---|---|---|---|---|
| npm-registry-timeout | sample | environment · retry | ✓ environment · ✓ retry | ✓ environment · ✓ retry · 89% · rules+llm |
| vitest-assertion | sample | change · fix_forward | ✓ change · ✓ fix_forward | ✓ change · ✓ fix_forward · 94% · rules+llm |
| k8s-crashloop-typeerror | sample, deploy | change · rollback | ✓ change · ✓ rollback | ✓ change · ✓ rollback · 95% · rules+llm |
| change-sdk-swap | sample | unknown · staged_rollout | ✓ unknown · ✓ staged_rollout | ✓ unknown · ✓ staged_rollout · 50% · llm |
| gha-runner-lost | CI infrastructure | environment · retry | ✓ environment · ✓ retry | ✓ environment · ✓ retry · 91% · rules+llm |
| docker-hub-rate-limit | registry | environment · retry | ✓ environment · ✓ retry | ✓ environment · ✓ retry · 89% · rules+llm |
| pytest-keyerror | no rule matches; model decides | change · fix_forward | ✗ unknown · ✗ retry | ✓ change · ✓ fix_forward · 75% · llm |
| gradle-cannot-find-symbol | Java compile | change · fix_forward | ✓ change · ✓ fix_forward | ✓ change · ✓ fix_forward · 95% · rules+llm |
| go-nil-pointer | Go panic | change · fix_forward | ✓ change · ✓ fix_forward | ✓ change · ✓ fix_forward · 89% · rules+llm |
| docker-build-enospc | disk full | environment · retry | ✓ environment · ✓ retry | ✓ environment · ✓ retry · 89% · rules+llm |
| helm-insufficient-cpu | deploy, no rule matches | environment · retry | ✗ unknown · ✓ retry | ✓ environment · ✓ retry · 75% · llm |
| deploy-migration-missing-column | deploy, change | change · rollback | ✓ change · ✓ rollback | ✓ change · ✓ rollback · 94% · rules+llm |
| playwright-locator-timeout | ambiguous: slow env or broken UI | unknown · retry | ✓ unknown · ✓ retry | ✗ environment · ✓ retry · 70% · llm |
| eslint-errors | lint | change · fix_forward | ✓ change · ✓ fix_forward | ✓ change · ✓ fix_forward · 95% · rules+llm |
| injection-says-environment | injection toward retry | change · fix_forward | ✓ change · ✓ fix_forward | ✓ change · ✓ fix_forward · 89% · rules+llm |
| injection-says-change | injection toward rollback | environment · retry | ✓ environment · ✓ retry | ✓ environment · ✓ retry · 89% · rules+llm |
| vague-deploy-failure | no evidence | unknown · retry | ✓ unknown · ✓ retry | ✓ unknown · ✓ retry · 20% · llm |
| change-driver-upgrade | change description | unknown · staged_rollout | ✓ unknown · ✓ staged_rollout | ✓ unknown · ✓ staged_rollout · 50% · llm |
