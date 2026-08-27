# Contribuer à StudentLLM

## Développement local

```bash
npm ci
npm run check
npm run test:run
npm run build
```

Les tests E2E et les providers sont lancés avant une PR lorsqu'ils sont concernés:

```bash
npm run test:e2e
npm run providers:smoke
```

## Branches et commits

- `feat/<sujet>` pour une fonctionnalité;
- `fix/<sujet>` pour une correction;
- `docs/<sujet>` pour la documentation;
- un objectif logique par commit;
- messages de commit en style Conventional Commits, par exemple `feat: add course session shell`.

Ne mélangez pas refonte visuelle, changement métier et mise à jour de documentation dans un commit quand ils peuvent être vérifiés séparément.

## Pull requests

1. Décrire le problème et le résultat attendu.
2. Ajouter ou mettre à jour les tests pertinents.
3. Joindre les commandes et résultats observés.
4. Signaler explicitement toute limite ou métrique non mesurée.
5. Attendre une CI verte.
6. Merger en squash sur `main`, puis supprimer la branche fusionnée.

## Données et secrets

Ne commitez jamais les clés API, `.env`, audio de cours, documents étudiants, dumps de base ou sorties de benchmark contenant des données privées. Voir [SECURITY.md](./SECURITY.md).
