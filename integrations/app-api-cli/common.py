"""Shared, dependency-free helpers for the read-only app search CLIs."""
import re

# Saved Home pin read from the authenticated noon account (BanyanTree Hillside -
# Flat 2104). Talabat/Careem captures were taken ~30 m away at the same building.
HOME_LAT, HOME_LNG = 25.0778251, 55.1569039
HOME_NAME = 'Banyan Tree Residences Hillside, Flat 2104, JLT'

TAG = re.compile(r'\s*[\(\[](?:ans|new|best ?seller|popular|chef.?s special|spicy|v|vg|veg|raw)[\)\]]\s*', re.I)
HTML = re.compile(r'<[^>]*>')

# Item-name vocab for food words whose dishes rarely repeat the word itself.
SYNONYMS = {
    'sushi': ['sushi', 'maki', 'nigiri', 'uramaki', 'hosomaki', 'futomaki',
              'temaki', 'gunkan', 'california roll', 'dragon roll', 'rainbow roll',
              'philadelphia roll', 'salmon roll', 'tuna roll', 'crunchy roll', 'aburi'],
    'seaweed salad': ['seaweed salad', 'wakame', 'kaiso salad', 'chuka salad', 'hiyashi wakame'],
    'seaweed': ['seaweed', 'wakame', 'kaiso', 'chuka'],
    'biryani': ['biryani', 'biriyani', 'briyani'],
    'shawarma': ['shawarma', 'shawerma', 'shawurma'],
    'protein shake': ['protein shake', 'protein smoothie', 'whey shake'],
    'burger': ['burger'],
    'pizza': ['pizza'],
    'smetana': ['smetana', 'sour cream'],
}


# Item names that contain the term but are not the dish (e.g. "Sushi Rice").
EXCLUDE = {
    'sushi': ['rice', 'burrito', 'pokerrito', 'bowl', 'salad', 'sauce', 'ginger', 'wasabi', 'soy', 'box only', 'tray'],
    'seaweed salad': [],
    'pizza': ['sauce', 'dough'],
    'burger': ['sauce', 'bun only'],
}


def clean_name(name):
    name = HTML.sub('', str(name or ''))
    name = TAG.sub(' ', name)
    return re.sub(r'\s{2,}', ' ', name).strip(' -,')


def money(value):
    if value is None or value == '':
        return None
    try:
        return round(float(value) + 1e-9, 2)
    except (TypeError, ValueError):
        return None


def eta_range(text):
    nums = [int(n) for n in re.findall(r'\d+', str(text or ''))]
    if not nums:
        return None
    return (nums[0], nums[1] if len(nums) > 1 else nums[0])


def tokens(query):
    return [t for t in re.findall(r'[a-z0-9]+', str(query).casefold()) if len(t) > 1]


def words_in(text, words):
    if not words:
        return False
    hay = ' ' + re.sub(r'[^a-z0-9]+', ' ', str(text or '').casefold()) + ' '
    return all(re.search(r'\s' + re.escape(w) + r'(?:s|es)?\s', hay) for w in words)


def term_patterns(term, synonyms=True):
    term = ' '.join(tokens(term))
    alts = SYNONYMS.get(term, [term]) if synonyms else [term]
    if term not in alts:
        alts = [term] + alts
    return [tokens(a) for a in alts]


def item_matches(term, name, category='', synonyms=True):
    """Match a term on item names, with explicit culinary synonyms.

    Descriptions are deliberately ignored: they mention garnishes and sides.
    """
    pats = term_patterns(term, synonyms)
    key = ' '.join(tokens(term))
    if synonyms and any(words_in(name, tokens(x)) for x in EXCLUDE.get(key, [])):
        return None
    if any(words_in(name, p) for p in pats):
        return 'name'
    return None


def relevance(query, name, cuisines=''):
    words = tokens(query)
    if not words:
        return 0
    if words_in(name, words):
        return 3
    if any(words_in(name, [w]) for w in words):
        return 2
    alts = term_patterns(query)
    if any(words_in(cuisines, p) for p in alts) or any(words_in(name, p) for p in alts):
        return 1.5
    return 0


def area_from_branch(branch, name=''):
    parts = [p.strip() for p in str(branch or '').split(',') if p.strip()]
    if len(parts) > 1:
        parts = parts[1:]
    elif parts and name and parts[0].casefold() == str(name).strip().casefold():
        return None
    # "JLT, Jumeirah Lakes Towers - JLT" -> keep the descriptive tail once.
    return parts[-1] if parts else None
