// Backend da integração PIX SyncPay — não coloque credenciais no navegador.
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({limit:"100kb"}));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const BASE = "https://api.syncpayments.com.br/api/partner/v1";
const DB_FILE = process.env.ORDERS_FILE ? path.resolve(process.env.ORDERS_FILE) : path.join(__dirname, "orders.json");
let tokenCache = { value:null, expiresAt:0 };

function readOrders(){
  try { return JSON.parse(fs.readFileSync(DB_FILE,"utf8")); }
  catch { return {}; }
}
function saveOrders(data){ fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2)); }

async function getAccessToken(){
  if(tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;
  const r = await fetch(`${BASE}/auth-token`, {
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({
      client_id:process.env.SYNCPAY_CLIENT_ID,
      client_secret:process.env.SYNCPAY_CLIENT_SECRET
    })
  });
  const data = await r.json();
  if(!r.ok || !data.access_token) throw new Error(data.error_description || data.message || "Falha na autenticação SyncPay.");
  tokenCache = {value:data.access_token, expiresAt:Date.now()+(Number(data.expires_in)||3600)*1000};
  return tokenCache.value;
}

app.post("/api/create-pix", async (req,res)=>{
  try{
    if(!process.env.SYNCPAY_CLIENT_ID || !process.env.SYNCPAY_CLIENT_SECRET)
      return res.status(503).json({error:"Configure as credenciais SyncPay no arquivo .env."});
    const {email,phone} = req.body || {};
    const cleanEmail = String(email||"").trim();
    const cleanPhone = String(phone||"").replace(/\D/g,"");
    if(!/^\S+@\S+\.\S+$/.test(cleanEmail) || cleanPhone.length<10)
      return res.status(400).json({error:"Confira seu e-mail e WhatsApp."});

    const publicUrl = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    const webhookKey = String(process.env.WEBHOOK_SECRET || "").trim();
    if(publicUrl && (!/^https:\/\/[^/]+$/i.test(publicUrl) || !webhookKey))
      return res.status(503).json({error:"Configure PUBLIC_URL com a URL HTTPS base e WEBHOOK_SECRET."});
    const webhookUrl = publicUrl ? publicUrl + "/api/syncpay-webhook?key=" + encodeURIComponent(webhookKey) : "";
    const token = await getAccessToken();
    const payload = {
      amount:9.99,
      description:"Repertório Musical 2027",
      client:{name:"repertoriomusical",email:cleanEmail,phone:cleanPhone}
    };
    if(webhookUrl) payload.webhook_url = webhookUrl;

    const r = await fetch(`${BASE}/cash-in`,{
      method:"POST",
      headers:{"Authorization":`Bearer ${token}`,"Accept":"application/json","Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const data = await r.json();
    if(!r.ok || !data.pix_code || !data.identifier)
      return res.status(r.status||502).json({error:data.message || data.error || "SyncPay não conseguiu criar a cobrança.",details:data.errors||undefined});

    const orders=readOrders();
    orders[data.identifier]={
      identifier:data.identifier, status:"pending", amount:9.99,
      email:cleanEmail,phone:cleanPhone,
      createdAt:new Date().toISOString()
    };
    saveOrders(orders);
    const qrCode = await QRCode.toDataURL(data.pix_code,{width:320,margin:1});
    res.json({identifier:data.identifier,pix_code:data.pix_code,qrCode});
  }catch(err){
    console.error("create-pix:",err);
    res.status(500).json({error:err.message || "Erro interno ao gerar PIX."});
  }
});

// Webhook: a URL pública precisa estar configurada no .env e acessível pela SyncPay.
app.post("/api/syncpay-webhook",(req,res)=>{
  const webhookSecret=String(process.env.WEBHOOK_SECRET||"").trim();
  if(!webhookSecret || req.query.key !== webhookSecret)
    return res.status(401).send("Unauthorized");
  const body=req.body||{};
  const transaction=body.data || body;
  const identifier=transaction.identifier || transaction.id || body.identifier || body.id;
  if(identifier){
    const orders=readOrders();
    if(orders[identifier]){
      const status=String(transaction.status||body.status||"").toLowerCase();
      if(["completed","paid","approved","success"].includes(status)){
        orders[identifier].status="paid";
        orders[identifier].paidAt=new Date().toISOString();
        saveOrders(orders);
      }
    }
  }
  res.status(200).json({received:true});
});

app.get("/api/pix-status/:identifier",(req,res)=>{
  const order=readOrders()[req.params.identifier];
  if(!order) return res.status(404).json({error:"Pedido não encontrado."});
  res.json({status:order.status});
});

app.get("/api/health",(_req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Imperio CDs rodando em http://localhost:${PORT}`));
