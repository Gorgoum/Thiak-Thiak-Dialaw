"""Génère les images de l'application à partir du logo d'origine (assets/logo-source.png).

- public/icons/icon-{96,180,192,512}.png : icône carrée, le livreur sur fond blanc
  (écran d'accueil du téléphone, onglet du navigateur, notifications)
- public/img/logo.webp : logo complet pour les pages (écrans de connexion, page « position »)
- public/img/logo-partage.jpg : image d'aperçu quand un lien est partagé (WhatsApp, Facebook…)

Usage : python scripts/generer-logo.py   (nécessite Pillow : pip install pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / 'assets' / 'logo-source.png'
FOND = (255, 255, 255)  # le logo est dessiné sur fond blanc


def icone(logo: Image.Image) -> Image.Image:
    """Le livreur souriant et son scooter, centrés sur un carré blanc (sans le texte), bas fondu."""
    bande = logo.crop((330, 8, 1060, 505))
    largeur, hauteur = bande.size
    masque = Image.new('L', bande.size, 255)
    dessin = ImageDraw.Draw(masque)
    bas = int(hauteur * 0.16)
    for y in range(hauteur - bas, hauteur):
        dessin.line([(0, y), (largeur, y)], fill=int(255 * (hauteur - y) / bas))
    marge = int(largeur * 0.06)  # un peu d'air autour du dessin
    cote = largeur + 2 * marge
    carre = Image.new('RGB', (cote, cote), FOND)
    carre.paste(bande, (marge, (cote - hauteur) // 2), masque)
    return carre


def main() -> None:
    logo = Image.open(SOURCE).convert('RGB')
    (RACINE / 'public' / 'img').mkdir(exist_ok=True)

    carre = icone(logo)
    for taille in (96, 180, 192, 512):
        carre.resize((taille, taille), Image.LANCZOS).save(
            RACINE / 'public' / 'icons' / f'icon-{taille}.png', optimize=True)

    complet = logo.resize((900, 600), Image.LANCZOS)
    complet.save(RACINE / 'public' / 'img' / 'logo.webp', quality=82, method=6)
    logo.resize((1200, 800), Image.LANCZOS).save(
        RACINE / 'public' / 'img' / 'logo-partage.jpg', quality=84, optimize=True, progressive=True)

    for f in sorted((RACINE / 'public' / 'icons').glob('icon-*.png')) + sorted((RACINE / 'public' / 'img').iterdir()):
        print(f'{f.relative_to(RACINE)} : {f.stat().st_size // 1024} Ko')


if __name__ == '__main__':
    main()
