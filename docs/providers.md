# Providers et secrets

## NVIDIA NIM

La clé NVIDIA n'est pas stockée dans le dépôt et ne doit pas l'être. Le programme lit `NVIDIA_API_KEY` depuis l'environnement au moment de l'exécution.

Dans PowerShell, configurer le scope utilisateur avec une valeur fournie hors dépôt:

```powershell
[Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', '<votre-cle>', 'User')
```

Fermer puis rouvrir le terminal pour que les nouveaux processus héritent de la variable. Ne jamais afficher la valeur dans un log, une capture d'écran ou une commande commitée.

Endpoint par défaut: `https://integrate.api.nvidia.com/v1`.

Le modèle par défaut du smoke test est `openai/gpt-oss-20b`, surchargeable avec `NVIDIA_MODEL`. Le catalogue NVIDIA peut exposer des modèles historiques ou indisponibles pour la génération; le smoke test vérifie séparément la liste et une vraie génération.

## LM Studio

LM Studio est consommé comme serveur local OpenAI-compatible:

```powershell
lms server status
lms ls
lms load qwen/qwen3-4b --gpu max --ttl 600 --yes
```

Endpoint par défaut: `http://127.0.0.1:1234/v1`.

Surcharge possible:

```powershell
$env:LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:LM_STUDIO_MODEL = 'qwen/qwen3-4b'
```

Le smoke test ajoute `/no_think` au prompt du modèle Qwen afin de mesurer le contenu final et non une sortie de raisonnement tronquée.

## Test réel

```bash
npm run providers:smoke
```

Le résultat attendu comprend une ligne `PASS` pour chaque provider disponible. Un provider indisponible doit être signalé comme tel, pas remplacé silencieusement par une simulation.

Les secrets ne sont jamais nécessaires pour les tests Vitest, les tests E2E ou le build frontend.
