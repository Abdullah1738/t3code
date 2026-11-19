"""Shared positive status phrases for merchant mail and notifications."""
import re


def delivered_elapsed(text):
    # Match the whole subject: extra words can turn elapsed time into a promise.
    normalized = ' '.join(text.lower().split())
    return re.fullmatch(r'delivered in \d+ (?:hrs?|hours?)(?: \d+ (?:mins?|minutes?))?[.!]?', normalized) is not None
