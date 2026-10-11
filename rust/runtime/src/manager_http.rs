use crate::{manager_config::{self,InstanceInput},manager_core::RuntimeManager};
use anyhow::{Context,Result};
use async_stream::stream;
use axum::{
    body::{to_bytes,Body},
    extract::State,
    http::{header::{CONTENT_TYPE,COOKIE,HOST,ORIGIN,SET_COOKIE},HeaderMap,HeaderValue,Method,Request,StatusCode},
    response::{sse::{Event,KeepAlive,Sse},IntoResponse,Response},
    routing::any,Json,Router,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::Arc,time::Duration};
use tokio::{net::TcpListener,sync::Notify};
#[derive(Clone)]
struct AppState {
    manager:Arc<RuntimeManager>,
    web_dir:PathBuf,
    token:String,
    port:u16,
    shutdown:Arc<Notify>,
}
fn err(status:StatusCode,message:impl Into<String>)->Response{(status,Json(json!({"error":message.into()}))).into_response()}
fn allowed_host(headers:&HeaderMap,port:u16)->bool{
    let host=headers.get(HOST).and_then(|v|v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    host==format!("127.0.0.1:{port}")||host==format!("localhost:{port}")||host==format!("[::1]:{port}")
}
fn authorized(headers:&HeaderMap,token:&str)->bool{
    use subtle::ConstantTimeEq;
    headers.get(COOKIE).and_then(|v|v.to_str().ok()).unwrap_or("")
        .split(';').filter_map(|v|v.trim().split_once('='))
        .any(|(key,value)|key.trim()=="wtm_session" && {
            let a=value.trim().as_bytes();let b=token.as_bytes();
            a.len()==b.len() && bool::from(a.ct_eq(b))
        })
}
fn origin_ok(headers:&HeaderMap,port:u16)->bool{
    let o=headers.get(ORIGIN).and_then(|v|v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    o==format!("http://127.0.0.1:{port}")||o==format!("http://localhost:{port}")||o==format!("http://[::1]:{port}")
}
fn secure(mut res:Response)->Response {
    let headers=res.headers_mut();
    headers.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
    headers.insert("x-content-type-options",HeaderValue::from_static("nosniff"));
    headers.insert("x-frame-options",HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy",HeaderValue::from_static("no-referrer"));
    res
}
async fn app(State(state):State<AppState>, request:Request<Body>)->Response{
    secure(dispatch(state,request).await)
}
async fn dispatch(state:AppState,request:Request<Body>)->Response{
    if !allowed_host(request.headers(),state.port){return err(StatusCode::FORBIDDEN,"Forbidden host.");}
    let method=request.method().clone();
    let uri=request.uri().clone();
    let path=uri.path().to_string();
    if let Some(query)=uri.query(){
        if let Some((_,value))=url::form_urlencoded::parse(query.as_bytes()).find(|(k,_)|k=="token"){
            use subtle::ConstantTimeEq;
            let a=value.as_bytes();let b=state.token.as_bytes();
            if a.len()==b.len() && bool::from(a.ct_eq(b)){
                let dest=format!("{}{}",path,uri.query().map(|q|{
                    let filtered=url::form_urlencoded::parse(q.as_bytes()).filter(|(k,_)|k!="token")
                        .map(|(k,v)|format!("{}={}",k,v)).collect::<Vec<_>>();
                    if filtered.is_empty(){String::new()}else{format!("?{}",filtered.join("&"))}
                }).unwrap_or_default());
                let mut res=(StatusCode::FOUND,[(axum::http::header::LOCATION,dest)]).into_response();
                res.headers_mut().insert(SET_COOKIE,HeaderValue::from_str(&format!("wtm_session={}; HttpOnly; SameSite=Strict; Path=/",state.token)).unwrap());
                res.headers_mut().insert("cache-control",HeaderValue::from_static("no-store"));
                return res;
            }
        }
    }
    if !authorized(request.headers(),&state.token){return err(StatusCode::UNAUTHORIZED,"Not authorized. Open the link printed by AI Local Hub.");}
    if [Method::POST,Method::PUT,Method::PATCH,Method::DELETE].contains(&method) && !origin_ok(request.headers(),state.port){
        return err(StatusCode::FORBIDDEN,"Cross-origin request blocked.");
    }
    if path.starts_with("/api/"){return api(state,request).await;}
    if method!=Method::GET && method!=Method::HEAD{return err(StatusCode::METHOD_NOT_ALLOWED,"Method not allowed.");}
    static_file(&state.web_dir,&path,method==Method::HEAD).await
}
async fn json_body(req:Request<Body>)->Result<Value,Response>{
    let json_type=req.headers().get(CONTENT_TYPE).and_then(|v|v.to_str().ok()).unwrap_or("");
    if !json_type.to_ascii_lowercase().starts_with("application/json"){return Err(err(StatusCode::UNSUPPORTED_MEDIA_TYPE,"Content-Type must be application/json."));}
    let body=to_bytes(req.into_body(),64*1024).await.map_err(|_|err(StatusCode::PAYLOAD_TOO_LARGE,"Request body is too large."))?;
    let value:Value=serde_json::from_slice(&body).map_err(|_|err(StatusCode::BAD_REQUEST,"Request body is not valid JSON."))?;
    if !value.is_object(){return Err(err(StatusCode::BAD_REQUEST,"Request body must be a JSON object."));}
    Ok(value)
}
async fn api(state:AppState,req:Request<Body>)->Response{
    let path=req.uri().path().to_string();
    let method=req.method().clone();
    let parts=path.trim_start_matches("/api/").split('/').collect::<Vec<_>>();
    let kind=parts.first().copied().unwrap_or("");
    let id=parts.get(1).copied();
    let action=parts.get(2).copied();
    let mgr=&state.manager;
    if method==Method::GET && kind=="state" && id.is_none(){
        return Json(json!({"instances":mgr.views().await,"localOnly":mgr.local_only,"homeDir":manager_config::home(),"version":mgr.version})).into_response();
    }
    if method==Method::GET && kind=="events" && id.is_none(){
        let mut rx=mgr.subscribe();
        let events=stream!{
            loop {
                match rx.recv().await {
                    Ok(data)=>yield Ok::<Event,std::convert::Infallible>(Event::default().data(data)),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>continue,
                    Err(_) => break,
                }
            }
        };
        return Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(25)).text("ping")).into_response();
    }
    if method==Method::GET && kind=="fs" && id.is_none(){
        let requested=req.uri().query().and_then(|q|url::form_urlencoded::parse(q.as_bytes()).find(|(k,_)|k=="path").map(|(_,v)|v.into_owned()))
            .unwrap_or_else(||manager_config::home().to_string_lossy().into_owned());
        return match folder_listing(&requested){Ok(v)=>Json(v).into_response(),Err(e)=>err(StatusCode::BAD_REQUEST,e.to_string())};
    }
    if kind=="instances" {
        if id.is_none() && method==Method::POST{
            let body=match json_body(req).await{Ok(v)=>v,Err(e)=>return e};
            let input:InstanceInput=match serde_json::from_value(body){Ok(v)=>v,Err(_)=>return err(StatusCode::BAD_REQUEST,"Invalid request body.")};
            let created={
                let mut config=mgr.config.lock().await;
                let created=match manager_config::normalize(input,&config.instances,None){Ok(v)=>v,Err(e)=>return err(StatusCode::BAD_REQUEST,e.to_string())};
                config.instances.push(created.clone());
                if let Err(e)=manager_config::save(&mgr.config_path,&config){config.instances.pop();return err(StatusCode::INTERNAL_SERVER_ERROR,format!("Could not save config: {e}"));}
                created
            };
            mgr.announce().await;
            return (StatusCode::CREATED,Json(mgr.view(&created).await)).into_response();
        }
        if let Some(id)=id{
            let current=match mgr.get_instance(id).await{Some(i)=>i,None=>return err(StatusCode::NOT_FOUND,"Instance not found.")};
            if action.is_none() && method==Method::PUT{
                let body=match json_body(req).await{Ok(v)=>v,Err(e)=>return e};
                let mut input:InstanceInput=match serde_json::from_value(body){Ok(v)=>v,Err(_)=>return err(StatusCode::BAD_REQUEST,"Invalid request body.")};
                if input.api_key.trim().is_empty(){input.api_key=current.api_key.clone();}
                let updated={
                    let mut config=mgr.config.lock().await;
                    let others=config.instances.iter().filter(|i|i.id!=id).cloned().collect::<Vec<_>>();
                    let updated=match manager_config::normalize(input,&others,Some(id)){Ok(v)=>v,Err(e)=>return err(StatusCode::BAD_REQUEST,e.to_string())};
                    let mut next=config.clone();
                    if let Some(slot)=next.instances.iter_mut().find(|i|i.id==id){*slot=updated.clone();}
                    if let Err(e)=manager_config::save(&mgr.config_path,&next){return err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string());}
                    *config=next;
                    updated
                };
                mgr.announce().await;
                return Json(mgr.view(&updated).await).into_response();
            }
            if action.is_none()&&method==Method::DELETE{
                {
                    let mut c=mgr.config.lock().await;
                    let mut next=c.clone();
                    next.instances.retain(|o|o.id!=id);
                    if let Err(e)=manager_config::save(&mgr.config_path,&next){return err(StatusCode::INTERNAL_SERVER_ERROR,e.to_string());}
                    *c=next;
                }
                mgr.stop(id).await;
                mgr.announce().await;
                return StatusCode::NO_CONTENT.into_response();
            }
            if method==Method::GET && action==Some("logs"){return Json(json!({"lines":mgr.lines(id).await})).into_response();}
            if method==Method::POST && action==Some("start"){mgr.start(current.clone()).await;return Json(mgr.view(&current).await).into_response();}
            if method==Method::POST && action==Some("stop"){mgr.stop(id).await;return Json(mgr.view(&current).await).into_response();}
        }
    }
    if method==Method::POST && kind=="start-all" && id.is_none(){
        let all=mgr.config.lock().await.instances.clone();
        for instance in all{mgr.start(instance).await;}
        return StatusCode::NO_CONTENT.into_response();
    }
    if method==Method::POST && kind=="stop-all" && id.is_none(){mgr.stop_all().await;return StatusCode::NO_CONTENT.into_response();}
    if method==Method::POST && kind=="shutdown" && id.is_none(){
        state.shutdown.notify_one();
        return (StatusCode::ACCEPTED,Json(json!({"ok":true}))).into_response();
    }
    err(StatusCode::NOT_FOUND,"Not found.")
}
fn folder_listing(requested:&str)->Result<Value>{
    let path=PathBuf::from(requested);
    if !path.is_absolute(){anyhow::bail!("Path must be absolute.");}
    let entries=std::fs::read_dir(&path).with_context(||format!("Cannot read directory: {}",path.display()))?;
    let mut dirs=entries.filter_map(|e|e.ok()).filter(|e|e.path().is_dir())
        .filter_map(|e|{let n=e.file_name().to_string_lossy().into_owned();if n.starts_with('.'){None}else{Some(n)}})
        .collect::<Vec<_>>();
    dirs.sort();dirs.truncate(1_000);
    let path=path.canonicalize().unwrap_or(path);
    let parent=path.parent().map(|p|p.to_string_lossy().into_owned());
    Ok(json!({"path":path,"parent":parent,"dirs":dirs}))
}
async fn static_file(root:&Path,path:&str,head:bool)->Response{
    let decoded=match percent_encoding::percent_decode_str(path).decode_utf8(){Ok(v)=>v,Err(_)=>return StatusCode::BAD_REQUEST.into_response()};
    if decoded.contains('\0')||decoded.contains('\\'){return StatusCode::NOT_FOUND.into_response();}
    let relative=decoded.trim_start_matches('/');
    if Path::new(relative).components().any(|c|matches!(c,std::path::Component::ParentDir)){return StatusCode::NOT_FOUND.into_response();}
    let target=root.join(if relative.is_empty(){"index.html"}else{relative});
    let target=if target.is_file(){target}else{
        if Path::new(relative).extension().is_some(){return StatusCode::NOT_FOUND.into_response();}
        root.join("index.html")
    };
    let canonical_root=match root.canonicalize(){Ok(v)=>v,Err(_)=>return (StatusCode::SERVICE_UNAVAILABLE,"UI not built. Run npm run build.").into_response()};
    let canonical=match target.canonicalize(){Ok(p)=>p,Err(_)=>return StatusCode::NOT_FOUND.into_response()};
    if !canonical.starts_with(&canonical_root)||!canonical.is_file(){return StatusCode::NOT_FOUND.into_response();}
    let bytes=match tokio::fs::read(&canonical).await{Ok(v)=>v,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let mime=mime_guess::from_path(&canonical).first_or_octet_stream().to_string();
    let cache=if canonical.to_string_lossy().contains("/assets/"){"public, max-age=31536000, immutable"}else{"no-store"};
    let mut res=(StatusCode::OK,if head{Body::empty()}else{Body::from(bytes)}).into_response();
    if let Ok(value)=HeaderValue::from_str(&mime){res.headers_mut().insert(CONTENT_TYPE,value);}
    res.headers_mut().insert("cache-control",HeaderValue::from_static(cache));
    res
}
pub async fn listen(manager:Arc<RuntimeManager>,web_dir:PathBuf,token:String,preferred:u16,strict:bool,shutdown:Arc<Notify>)->Result<(u16,impl std::future::Future<Output=Result<()>>)>{
    let listener=match TcpListener::bind(("127.0.0.1",preferred)).await{
        Ok(l)=>l,Err(_error)if !strict=>TcpListener::bind(("127.0.0.1",0)).await?,Err(e)=>return Err(e.into())};
    let port=listener.local_addr()?.port();
    let state=AppState{manager,web_dir,token,port,shutdown:Arc::clone(&shutdown)};
    let app=Router::new().fallback(any(app)).with_state(state);
    let future=async move {
        axum::serve(listener,app)
            .with_graceful_shutdown(async move {shutdown.notified().await;})
            .await.context("HTTP server failed")
    };
    Ok((port,future))
}
