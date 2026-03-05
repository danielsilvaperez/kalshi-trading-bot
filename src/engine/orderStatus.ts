import axios from 'axios';

export async function fetchOrderStatus(baseUrl: string, token: string, orderId: string): Promise<string | null> {
  try {
    const r = await axios.get(`${baseUrl}/trade-api/v2/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data?.order?.status ?? r.data?.status ?? null;
  } catch {
    return null;
  }
}
