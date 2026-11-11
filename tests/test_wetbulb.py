"""Bulbo umido a 2 m (app/variables.py, wet_bulb_k)."""
import numpy as np

from app.variables import REGISTRY, wet_bulb_k

K = 273.15


def test_valori_di_riferimento():
    # tabelle psicrometriche a 1013 hPa: T 20 °C, rugiada 10 °C -> bulbo umido ~14,2 °C
    tw = wet_bulb_k(np.array([20 + K]), np.array([10 + K]))[0] - K
    assert abs(tw - 14.2) < 0.15


def test_saturo_e_limiti():
    t = np.array([5, -3, 30]) + K
    tw = wet_bulb_k(t, t) - K  # aria satura: bulbo umido = temperatura
    assert np.allclose(tw, [5, -3, 30], atol=0.01)
    td = np.array([-10, -15, 5]) + K
    tw = wet_bulb_k(t, td) - K
    assert np.all(tw <= t - K) and np.all(tw >= td - K)


def test_mancanti_restano_mancanti():
    tw = wet_bulb_k(np.array([np.nan, 10 + K]), np.array([5 + K, 5 + K]))
    assert np.isnan(tw[0]) and np.isfinite(tw[1])


def test_registrata_con_il_punto_di_rugiada():
    v = REGISTRY["tw2m"]
    assert v.combine is wet_bulb_k
    assert all(sel.dew is not None for sel in v.selectors.values())
    assert set(v.selectors) == set(REGISTRY["t2m"].selectors)
