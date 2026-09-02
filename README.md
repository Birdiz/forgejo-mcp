# forgejo-mcp-server

Serveur [MCP](https://modelcontextprotocol.io) pour Forgejo : il donne à un
assistant (Claude Code, Cursor…) de quoi lire un dépôt et gérer issues et pull
requests, sans quitter la session de travail.

Il fonctionne avec n'importe quelle instance Forgejo : l'URL cible est une
variable d'environnement, jamais une valeur codée en dur.

## Modèle de sécurité

**Le serveur n'a aucune autorité propre.** Il ne détient pas de token : il
relaie celui de l'appelant, et sans lui il ne peut rien faire.

| | Origine du token |
|---|---|
| `stdio` (local) | variable `FORGEJO_TOKEN` du poste de l'utilisateur |
| `http` (Railway) | en-tête `Authorization` de **chaque requête** |

Ce choix n'est pas cosmétique. Un token unique côté serveur aurait trois
conséquences : toutes les écritures attribuées à une seule personne dans
l'historique Forgejo, les permissions individuelles court-circuitées, et une URL
publique offrant un accès Forgejo à qui la découvre. Le serveur **refuse de
démarrer** en mode `http` si `FORGEJO_TOKEN` est défini.

Deux autres garde-fous :

- **L'URL de l'instance est fixée côté serveur**, jamais fournie par l'appelant :
  un modèle ne peut pas détourner le serveur vers un autre hôte (SSRF).
- **Les segments de chemin sont encodés** un par un, ce qui neutralise `..` et
  les slashs injectés dans `owner`, `repo` ou un chemin de fichier.

Le token n'est ni journalisé, ni renvoyé dans un message d'erreur.

## Token Forgejo

À créer sur `<instance>/user/settings/applications`, avec deux scopes :

| Scope | Ce qu'il permet |
|---|---|
| `write:issue` | créer et commenter des issues |
| `write:repository` | créer des pull requests, lire fichiers, branches et commits |

⚠️ **Forgejo ne sait pas isoler « créer une PR » de « écrire des fichiers »** :
les deux sont dans `write:repository`. Le token est donc plus large que les
outils exposés ici — aucun outil de ce serveur ne modifie de fichier, mais le
token, lui, le permettrait via l'API.

## Outils

| Outil | Accès | Fonction |
|---|---|---|
| `forgejo_whoami` | lecture | identité du token (vérifier avant d'écrire) |
| `forgejo_list_repos` | lecture | dépôts accessibles |
| `forgejo_list_issues` | lecture | issues, filtrables par état/étiquettes/texte |
| `forgejo_get_issue` | lecture | issue détaillée + commentaires |
| `forgejo_create_issue` | **écriture** | ouvrir une issue (étiquettes par nom) |
| `forgejo_comment_issue` | **écriture** | commenter une issue ou une PR |
| `forgejo_list_pull_requests` | lecture | pull requests par état |
| `forgejo_get_pull_request` | lecture | PR détaillée, diff optionnel |
| `forgejo_create_pull_request` | **écriture** | ouvrir une PR entre deux branches |
| `forgejo_list_branches` | lecture | branches et protections |
| `forgejo_list_commits` | lecture | historique d'une branche |
| `forgejo_get_file` | lecture | fichier ou dossier à une révision |

Tous acceptent `response_format` (`markdown` par défaut, `json` pour la donnée
brute) et bornent leur réponse à 25 000 caractères, en signalant toute coupe.

## Usage local (stdio)

```bash
pnpm install
pnpm build
```

Puis, côté client MCP, le token vient de l'environnement du shell : il n'est
jamais écrit dans un fichier versionné.

```bash
export FORGEJO_TOKEN="<ton token>"
```

## Déploiement Railway (http)

Railway ne s'intègre qu'à GitHub : depuis Forgejo, on déploie le dossier local
avec la CLI. Pas de déploiement automatique au push — c'est le prix de la sortie
de GitHub, et un job Forgejo Actions appelant `railway up` peut le rétablir.

```bash
npm i -g @railway/cli
railway login
railway init          # une seule fois, crée le projet
railway up            # build + déploiement
railway domain        # expose le service et donne son URL
```

Variables à définir sur le service (`railway variables --set ...` ou l'interface) :

| Variable | Valeur |
|---|---|
| `FORGEJO_URL` | `https://forgejo.example.org` |
| `TRANSPORT` | `http` |
| `FORGEJO_DEFAULT_OWNER` | facultatif, évite de répéter `owner` à chaque appel |
| `FORGEJO_DEFAULT_REPO` | facultatif, évite de répéter `repo` à chaque appel |
| `PORT` | `3000` — et saisir **le même** comme target port du domaine |

Railway exige que le target port du domaine soit exactement celui sur lequel le
service écoute, sinon la plateforme renvoie « Application failed to respond ».
Le serveur écoute sur `0.0.0.0:$PORT` : fixer `PORT` explicitement et reprendre
la même valeur pour le domaine supprime toute ambiguïté.

**Ne jamais définir `FORGEJO_TOKEN`** sur le service : le serveur refuse de
démarrer, précisément pour empêcher cette erreur.

`railway.json` fournit build, démarrage et sonde `/healthz`.

Chaque dev déclare ensuite le serveur avec **son** token :

```json
{
  "mcpServers": {
    "forgejo": {
      "type": "http",
      "url": "https://<service>.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer ${FORGEJO_TOKEN}" }
    }
  }
}
```

Le service est public : c'est acceptable précisément parce qu'un appel sans
token valide ne donne accès à rien. `/healthz` ne renvoie que l'URL de
l'instance et la version.

## Développement

```bash
pnpm dev        # tsc --watch
pnpm typecheck
pnpm start      # node dist/index.js
```

Vérification rapide sans client MCP :

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | FORGEJO_URL="https://forgejo.example.org" FORGEJO_TOKEN="x" node dist/index.js
```

## Limites connues

- Pas de fusion de PR, pas de revue, pas de gestion d'étiquettes ou de jalons :
  le périmètre s'arrête à lire, ouvrir et commenter.
- `forgejo_create_issue` ne pose que des étiquettes **existantes** ; les noms
  inconnus sont ignorés et signalés dans la réponse.
- Les fichiers binaires ne sont pas décodés (taille et SHA seulement).
- La pagination est plafonnée à 50 éléments par page, limite de l'API Forgejo.
