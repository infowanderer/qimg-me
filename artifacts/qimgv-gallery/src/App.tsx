import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router as WouterRouter, Switch } from 'wouter';
import Gallery from './pages/Gallery';

const queryClient = new QueryClient({defaultOptions:{queries:{staleTime:15000,refetchOnWindowFocus:false}}});

function App() {
  return <QueryClientProvider client={queryClient}>
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Switch>
        <Route path="/" component={Gallery}/>
        <Route><div className="state-panel" style={{margin:'10vh auto',maxWidth:560}}><h2>That page isn't here.</h2><p>The gallery lives at the root of this address.</p><a className="btn" href="./">Return to gallery</a></div></Route>
      </Switch>
    </WouterRouter>
  </QueryClientProvider>;
}

export default App;