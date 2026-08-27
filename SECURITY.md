# Sécurité

## Règles de base

- Les credentials provider sont fournis par l'environnement ou le gestionnaire de secrets de l'OS.
- `NVIDIA_API_KEY` n'est pas lu depuis un fichier du repo et sa valeur n'est jamais journalisée.
- Le mode local ne doit pas effectuer de requête réseau implicite.
- Les données de cours sont considérées comme privées par défaut.
- Les fichiers audio, images et documents d'utilisateurs ne doivent pas être ajoutés aux fixtures publiques sans autorisation.

## Signaler une vulnérabilité

Ne publiez pas de secret ni de détail exploitable dans une issue publique. Contactez les mainteneurs via les canaux privés du dépôt avec une description, une reproduction minimale et l'impact observé.

Les rapports de sécurité sont traités avant toute publication d'une correction afin d'éviter d'exposer une donnée utilisateur.
