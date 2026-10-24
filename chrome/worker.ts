import {checkProposal} from '../src/check/proposal';
self.onmessage = ({data}) => {
  try { self.postMessage({ticket:data.ticket, result:checkProposal(data.input)}); }
  catch (error) { self.postMessage({ticket:data.ticket,result:{stage:'incomplete',attention:[],error:String(error)}}); }
};
